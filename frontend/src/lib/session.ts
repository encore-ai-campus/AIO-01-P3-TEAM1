// 로그인 상태였다가 세션이 끝난 표시 (RequireAuth의 AuthBridge가 남기고, 로그인 화면이 한 번 읽고 지운다).
// 이유 없이 로그인 화면으로 튕기면 '내가 뭘 잘못 눌렀나' 오해하므로, 다시 로그인하면 보던 화면으로 돌아간다고 알린다.
const KEY = "paper-expired";

export function markSessionExpired() {
  try {
    sessionStorage.setItem(KEY, "1");
  } catch {
    // 저장할 수 없으면 안내 없이 로그인 화면만 보인다
  }
}

export function readSessionExpired(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function clearSessionExpired() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // 지울 수 없으면 그대로 둔다 (탭을 닫으면 사라진다)
  }
}
