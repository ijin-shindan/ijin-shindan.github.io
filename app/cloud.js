// Googleログイン・クラウド保存（任意機能）。
// data/firebase.json の enabled が true のときだけ実際に動く。false のままなら、
// すべての関数が「未設定」を返すだけで、エラーにはならない（ログインなしのサイトとして今までどおり動く）。
// 呼び出し側（main.js）は、ユーザーがログインボタンを押した時など、必要なときだけ import() する（未使用の人には読み込ませない）。
//
// 保存先（Firestore。有効化した本人のプロジェクトのみ。他の人とは共有されない）：
//   users/{uid}                          … プロフィールと図鑑のクラウド版（本体は今まで通り localStorage。ログイン時にだけ合流する）
//   invites/{token}                      … 招待リンク1つぶんの情報（持ち主の uid、作成日時）
//   invites/{token}/responses/{autoId}   … その招待リンクから友達が診断した結果（現状は「友達自身」の診断結果。本人についての他己診断はまだ実装していない＝仮実装）
//
// 書き込みの回数を抑えるため、細かい操作のたびには書かない。ログイン直後・図鑑が増えた瞬間・マイページを開いた時だけまとめて書く。

let _configPromise = null;
async function getConfig() {
  if (!_configPromise) {
    _configPromise = fetch("../data/firebase.json").then((r) => r.json()).catch(() => ({ enabled: false }));
  }
  return _configPromise;
}

let _appPromise = null;
async function initApp() {
  const cfg = await getConfig();
  if (!cfg.enabled || !cfg.config) return null;
  if (!_appPromise) {
    _appPromise = (async () => {
      const [{ initializeApp }, authMod, fsMod] = await Promise.all([
        import("https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js"),
        import("https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js"),
        import("https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js"),
      ]);
      const app = initializeApp(cfg.config);
      const auth = authMod.getAuth(app);
      const db = fsMod.getFirestore(app);
      return { app, auth, db, authMod, fsMod };
    })();
  }
  return _appPromise;
}

// ログイン状態が変わるたびに呼ばれる。有効化していないときは一度も呼ばれない
export async function onAuthChange(cb) {
  const ctx = await initApp();
  if (!ctx) return () => {};
  return ctx.authMod.onAuthStateChanged(ctx.auth, (user) => cb(user ? { uid: user.uid, name: user.displayName, photo: user.photoURL, email: user.email } : null));
}

// ログイン開始：ポップアップ方式（signInWithPopup）を使う。
//
// 実測の経緯（2026-09-29）：
// 最初はポップアップ方式で実装し、実機で最後まで（Firestoreへの保存まで）成功していた。
// その後、①別の不具合（onAuthStateChangedのコールバック内でのReferenceError）が原因で
// 画面が固まる症状が出たため、②切り分けのためページ遷移方式（signInWithRedirect）へ変更した。
// ところが redirect 方式では、Googleの画面から戻ってきた直後、エラーは出ないまま
// getRedirectResult() が一貫して「ログイン情報なし」を返した（実機のログで確認）。
// これは、authDomain（ijin-shindan.firebaseapp.com）とアプリ本体（ijin-shindan.github.io）が
// 別ドメインであることに起因する、既知のFirebaseの制約が原因と考えられる：
// redirect方式は、Googleから戻る際の認証情報を、両ドメインをまたいだストレージ経由で
// 橋渡しする必要があり、ブラウザのサードパーティストレージ制限下ではこれが
// エラーも出さずに失敗することがある。
// 一方popup方式は、別ウィンドウとの postMessage で直接やり取りするため、この制約を受けにくい。
// ①の不具合はすでに修正済みのため、実績のあるpopup方式に戻した。
export async function signIn() {
  const ctx = await initApp();
  if (!ctx) throw new Error("not_configured");
  const provider = new ctx.authMod.GoogleAuthProvider();
  const { user } = await ctx.authMod.signInWithPopup(ctx.auth, provider);
  return { uid: user.uid, name: user.displayName, photo: user.photoURL, email: user.email };
}

export async function signOutUser() {
  const ctx = await initApp();
  if (!ctx) return;
  await ctx.authMod.signOut(ctx.auth);
}

// クラウド側のプロフィールを1回だけ読む（ログイン直後・マイページを開いた時）
export async function pullProfile(uid) {
  const ctx = await initApp();
  if (!ctx) return null;
  const snap = await ctx.fsMod.getDoc(ctx.fsMod.doc(ctx.db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

// クラウド側へまとめて書く（マージ。頻繁に呼ばない）
export async function pushProfile(uid, patch) {
  const ctx = await initApp();
  if (!ctx) return;
  await ctx.fsMod.setDoc(ctx.fsMod.doc(ctx.db, "users", uid), { ...patch, updatedAt: Date.now() }, { merge: true });
}

// 招待リンクの発行（初回だけ）。token は当たり障りのないランダム文字列
export async function ensureInvite(uid, token) {
  const ctx = await initApp();
  if (!ctx) return;
  await ctx.fsMod.setDoc(ctx.fsMod.doc(ctx.db, "invites", token), { ownerUid: uid, createdAt: Date.now() }, { merge: true });
}

// 招待リンク経由で友達が診断した結果を記録する。
// entry.mode = "friend" は「友達から見た招待主」の結果（本人についての他己診断）。回答者の身元は保存しない
export async function recordInviteResponse(token, entry) {
  const ctx = await initApp();
  if (!ctx) return false;
  const ref = ctx.fsMod.doc(ctx.fsMod.collection(ctx.db, "invites", token, "responses"));
  await ctx.fsMod.setDoc(ref, { ...entry, at: Date.now() });
  return true;
}

// 招待リンクから届いた結果の件数だけ数える（マイページ表示用。中身は読まない＝軽い）
export async function countInviteResponses(token) {
  const ctx = await initApp();
  if (!ctx) return 0;
  const snap = await ctx.fsMod.getCountFromServer(ctx.fsMod.collection(ctx.db, "invites", token, "responses"));
  return snap.data().count;
}

// 招待の持ち主が、届いた「友達診断」だけをまとめて読む（本人ログイン時のみ）。
// Security Rulesで、招待の持ち主本人だけがこのサブコレクションを読めるよう制限している
export async function pullFriendResponses(token) {
  const ctx = await initApp();
  if (!ctx) return [];
  const q = ctx.fsMod.query(
    ctx.fsMod.collection(ctx.db, "invites", token, "responses"),
    ctx.fsMod.where("mode", "==", "friend")
  );
  const snap = await ctx.fsMod.getDocs(q);
  return snap.docs.map((d) => d.data());
}

export async function isCloudEnabled() {
  const cfg = await getConfig();
  return !!(cfg.enabled && cfg.config);
}
