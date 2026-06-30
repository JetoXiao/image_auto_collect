const form = document.querySelector("#loginForm");
const username = document.querySelector("#username");
const password = document.querySelector("#password");
const errorBox = document.querySelector("#loginError");

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }
  return payload;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const button = form.querySelector("button");
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = "登录中";
  try {
    await requestJson("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: username.value.trim(),
        password: password.value
      })
    });
    window.location.href = "/";
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    password.select();
  } finally {
    button.disabled = false;
    button.textContent = oldText;
  }
});
