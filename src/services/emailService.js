import nodemailer from "nodemailer";

export function getDigestEmailConfig(env = process.env) {
  const user = String(env.GMAIL_USER || "").trim();
  const appPassword = String(env.GMAIL_APP_PASSWORD || "").trim();
  const to = String(env.DIGEST_EMAIL_TO || "").trim();
  return {
    user,
    appPassword,
    to,
    from: user,
    configured: Boolean(user && appPassword && to),
    missing: [
      !user ? "GMAIL_USER" : "",
      !appPassword ? "GMAIL_APP_PASSWORD" : "",
      !to ? "DIGEST_EMAIL_TO" : ""
    ].filter(Boolean)
  };
}

export function createGmailTransport(config = getDigestEmailConfig()) {
  if (!config.configured) {
    throw new Error(`Digest email is not configured. Missing: ${config.missing.join(", ")}`);
  }

  // Gmail SMTP requires a Google App Password, not the normal account password.
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: config.user,
      pass: config.appPassword
    }
  });
}

export async function sendDigestEmail({ subject, html, text }, options = {}) {
  const config = options.config || getDigestEmailConfig(options.env || process.env);
  const transport = options.transport || createGmailTransport(config);
  return await transport.sendMail({
    from: config.from,
    to: config.to,
    subject,
    html,
    text
  });
}
