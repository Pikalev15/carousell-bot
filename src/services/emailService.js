import nodemailer from "nodemailer";

export function getDigestEmailConfig(env = process.env, saved = {}) {
  const user = String(saved.gmailUser || env.GMAIL_USER || "").trim();
  const appPassword = String(saved.gmailAppPassword || env.GMAIL_APP_PASSWORD || "").trim();
  const to = String(saved.emailTo || env.DIGEST_EMAIL_TO || "").trim();
  const sendTime = normalizeDigestSendTime(saved.sendTime || env.DIGEST_SEND_TIME);
  return {
    user,
    appPassword,
    to,
    from: user,
    sendTime,
    enabled: saved.enabled === undefined ? true : Boolean(saved.enabled),
    configured: Boolean(user && appPassword && to),
    missing: [
      !user ? "Gmail address" : "",
      !appPassword ? "Gmail app password" : "",
      !to ? "Digest recipient" : ""
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
  const config = options.config || getDigestEmailConfig(options.env || process.env, options.saved || {});
  const transport = options.transport || createGmailTransport(config);
  return await transport.sendMail({
    from: config.from,
    to: config.to,
    subject,
    html,
    text
  });
}

export async function sendDigestTestEmail(options = {}) {
  return await sendDigestEmail(
    {
      subject: "Carousell Bot Top Deals test",
      html: "<p>Your Carousell Bot Gmail SMTP digest is configured.</p>",
      text: "Your Carousell Bot Gmail SMTP digest is configured."
    },
    options
  );
}

export function maskDigestEmailConfig(saved = {}, env = process.env) {
  const config = getDigestEmailConfig(env, saved);
  return {
    enabled: config.enabled,
    configured: config.configured,
    gmailUser: config.user,
    gmailAppPasswordConfigured: Boolean(config.appPassword),
    gmailAppPasswordPreview: config.appPassword ? `${config.appPassword.slice(0, 4)}...${config.appPassword.slice(-4)}` : "",
    emailTo: config.to,
    sendTime: config.sendTime,
    source: saved.gmailUser || saved.gmailAppPassword || saved.emailTo ? "local config" : config.configured ? "environment" : "missing",
    missing: config.missing
  };
}

export function normalizeDigestSendTime(value) {
  const text = String(value || "08:00").trim();
  const match = text.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : "08:00";
}
