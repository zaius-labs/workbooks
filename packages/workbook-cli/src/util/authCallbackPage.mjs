export function renderAuthCallbackPage({
  status = "success",
  title,
  message,
  detail,
} = {}) {
  const isSuccess = status === "success";
  const pageTitle = title ?? (isSuccess ? "You're signed in" : "Sign-in needs attention");
  const pageMessage = message ?? (
    isSuccess
      ? "The Workbooks CLI is authenticated."
      : "The Workbooks CLI could not finish authentication."
  );
  const pageDetail = detail ?? "You can close this tab and return to your terminal.";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle)} - Workbooks</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #141817;
      --muted: #5e6865;
      --line: #dfe5e2;
      --paper: #fbfcfb;
      --field: #ffffff;
      --green: #14825f;
      --green-soft: #dff5ec;
      --red: #b42318;
      --red-soft: #fff0ed;
      --blue: #3157d5;
      --shadow: 0 22px 70px rgba(20, 24, 23, 0.16);
    }

    * {
      box-sizing: border-box;
    }

    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 32px 18px;
      background:
        linear-gradient(120deg, rgba(49, 87, 213, 0.12), transparent 42%),
        linear-gradient(315deg, rgba(20, 130, 95, 0.12), transparent 44%),
        var(--paper);
      color: var(--ink);
      font: 15px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    main {
      width: min(100%, 560px);
      background: rgba(255, 255, 255, 0.9);
      border: 1px solid rgba(223, 229, 226, 0.85);
      border-radius: 8px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .brand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 22px 24px;
      border-bottom: 1px solid var(--line);
      background: rgba(255, 255, 255, 0.72);
    }

    .logo {
      display: flex;
      align-items: center;
      gap: 11px;
      color: var(--ink);
      font-weight: 700;
      letter-spacing: 0;
    }

    .logo svg {
      width: 34px;
      height: 34px;
      flex: 0 0 auto;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 30px;
      padding: 5px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 650;
      color: ${isSuccess ? "var(--green)" : "var(--red)"};
      background: ${isSuccess ? "var(--green-soft)" : "var(--red-soft)"};
    }

    .content {
      padding: 36px 32px 32px;
    }

    .status {
      width: 54px;
      height: 54px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      margin-bottom: 20px;
      color: ${isSuccess ? "var(--green)" : "var(--red)"};
      background: ${isSuccess ? "var(--green-soft)" : "var(--red-soft)"};
    }

    .status svg {
      width: 28px;
      height: 28px;
    }

    h1 {
      margin: 0;
      max-width: 12ch;
      font-size: clamp(34px, 8vw, 54px);
      line-height: 0.95;
      letter-spacing: 0;
    }

    p {
      margin: 16px 0 0;
      max-width: 42ch;
      color: var(--muted);
      font-size: 16px;
    }

    .detail {
      color: var(--ink);
      font-weight: 560;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 28px;
    }

    button {
      min-height: 42px;
      border: 1px solid var(--ink);
      border-radius: 7px;
      padding: 0 16px;
      background: var(--ink);
      color: white;
      cursor: pointer;
      font: inherit;
      font-weight: 650;
    }

    .ghost {
      border-color: var(--line);
      background: var(--field);
      color: var(--ink);
    }

    footer {
      padding: 18px 24px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      background: rgba(250, 252, 251, 0.88);
      font-size: 13px;
    }

    @media (max-width: 520px) {
      body {
        place-items: stretch;
        padding: 14px;
      }

      main {
        align-self: center;
      }

      .brand,
      .content,
      footer {
        padding-left: 20px;
        padding-right: 20px;
      }

      .brand {
        align-items: flex-start;
        flex-direction: column;
      }

      h1 {
        max-width: 10ch;
      }

      button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <main>
    <div class="brand">
      <div class="logo" aria-label="Workbooks">
        ${workbooksLogo()}
        <span>Workbooks</span>
      </div>
      <span class="pill">${isSuccess ? "CLI connected" : "Action needed"}</span>
    </div>
    <section class="content">
      <div class="status" aria-hidden="true">
        ${isSuccess ? successIcon() : errorIcon()}
      </div>
      <h1>${escapeHtml(pageTitle)}</h1>
      <p>${escapeHtml(pageMessage)}</p>
      <p class="detail">${escapeHtml(pageDetail)}</p>
      <div class="actions">
        <button type="button" onclick="window.close()">Close tab</button>
        <button class="ghost" type="button" onclick="location.href='about:blank'">Clear page</button>
      </div>
    </section>
    <footer>Authentication finished on your local Workbooks CLI callback.</footer>
  </main>
</body>
</html>`;
}

function workbooksLogo() {
  return `<svg viewBox="0 0 36 36" fill="none" role="img" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
    <rect x="3.5" y="4.5" width="21" height="27" rx="4.5" fill="#141817"/>
    <rect x="11.5" y="4.5" width="21" height="27" rx="4.5" fill="#3157D5"/>
    <path d="M17 12.5H27.5M17 18H27.5M17 23.5H24" stroke="white" stroke-width="2.3" stroke-linecap="round"/>
  </svg>`;
}

function successIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
    <path d="M20 6.5 9.5 17 4.5 12" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function errorIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 7.5V12.5M12 16.5H12.01" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M10.3 4.6 2.8 17.6C2.2 18.6 2.9 20 4.1 20H19.9C21.1 20 21.8 18.6 21.2 17.6L13.7 4.6C13.1 3.5 10.9 3.5 10.3 4.6Z" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"/>
  </svg>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]),
  );
}
