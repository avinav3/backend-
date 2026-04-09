const nodemailer = require("nodemailer");

let transporterPromise = null;

function parseBoolean(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no"].includes(normalized)) {
    return false;
  }

  return null;
}

function getMailConfig() {
  const service = String(process.env.MAIL_SERVICE || "").trim().toLowerCase();
  const host = String(process.env.SMTP_HOST || "").trim();
  const inferredService =
    service || (host.toLowerCase() === "smtp.gmail.com" ? "gmail" : "");

  return {
    service: inferredService,
    host,
    port: Number(process.env.SMTP_PORT || 0),
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    secure:
      parseBoolean(process.env.SMTP_SECURE) ??
      Number(process.env.SMTP_PORT || 0) === 465,
  };
}

function ensureMailConfig() {
  const config = getMailConfig();
  const requiredKeys = config.service
    ? ["user", "pass", "from"]
    : ["host", "port", "user", "pass", "from"];
  const missing = requiredKeys.filter((key) => {
    return !config[key];
  });

  if (missing.length) {
    const error = new Error(
      `Mail configuration is incomplete. Missing: ${missing.join(", ")}`,
    );
    error.code = "MAIL_CONFIG_MISSING";
    throw error;
  }

  return config;
}

async function getTransporter() {
  if (!transporterPromise) {
    transporterPromise = (async () => {
      const config = ensureMailConfig();
      const transporterConfig = config.service
        ? {
            service: config.service,
            auth: {
              user: config.user,
              pass: config.pass,
            },
          }
        : {
            host: config.host,
            port: config.port,
            secure: config.secure,
            auth: {
              user: config.user,
              pass: config.pass,
            },
            tls: {
              rejectUnauthorized: false,
            },
          };
      const transporter = nodemailer.createTransport(transporterConfig);

      await transporter.verify();
      console.log(
        config.service
          ? `SMTP transporter verified successfully using ${config.service}`
          : `SMTP transporter verified successfully for ${config.host}:${config.port}`,
      );
      return transporter;
    })().catch((error) => {
      transporterPromise = null;
      console.error("SMTP transporter verification failed:", error.message);
      throw error;
    });
  }

  return transporterPromise;
}

async function sendMail({ to, subject, text, html, replyTo }) {
  const transporter = await getTransporter();
  const { from } = ensureMailConfig();

  const info = await transporter.sendMail({
    from,
    to,
    subject,
    text,
    html,
    replyTo,
  });

  console.log(`Email queued successfully to ${to}. Message ID: ${info.messageId}`);

  return info;
}

function resolveSupportEmail() {
  return (
    process.env.SUPPORT_EMAIL ||
    process.env.MAIL_FROM ||
    process.env.SMTP_USER ||
    null
  );
}

module.exports = {
  sendMail,
  resolveSupportEmail,
};
