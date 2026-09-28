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

// ログイン開始：ポップアップ方式（signInWithPopup）ではなく、ページ遷移方式（signInWithRedirect）を使う。
// ポップアップは、内部でストレージ確認用の隠しiframeを使うため、モバイルのSafari／LINEやX等アプリ内ブラウザの
// サードパーティCookie制限で、ポップアップも出ないままハングする（エラーにもならず、画面が固まって見える）ことがある。
// リダイレクト方式は隠しiframeを使わないため、この種の環境でも確実に動く（Firebase公式が推奨する方式）。
// この関数を呼ぶと、この場でGoogleのページへ移動する（戻り値はない）。戻ってきたら consumeRedirectResult() で受け取る。
export async function beginSignIn() {
  const ctx = await initApp();
  if (!ctx) throw new Error("not_configured");
  const provider = new ctx.authMod.GoogleAuthProvider();
  await ctx.authMod.signInWithRedirect(ctx.auth, provider);
}

// Googleのページから戻ってきた直後に1回だけ呼ぶ。ログインが完了していれば本人の情報を返す。そうでなければ null
export async function consumeRedirectResult() {
  const ctx = await initApp();
  if (!ctx) return null;
  const cred = await ctx.authMod.getRedirectResult(ctx.auth);
  const user = cred?.user;
  return user ? { uid: user.uid, name: user.displayName, photo: user.photoURL, email: user.email } : null;
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

// 招待リンク経由で友達が診断した結果を記録する（現状は友達自身のSELF結果。本人についての他己診断は将来）
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

export async function isCloudEnabled() {
  const cfg = await getConfig();
  return !!(cfg.enabled && cfg.config);
}
