const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcrypt");
const nodemailer = require("nodemailer");
const { isDatabaseConnected } = require("../db");
const Users = require("../models/Users");
const { sendMail } = require("../utils/mail");

const router = express.Router();
const RESET_TOKEN_BYTES = 32;
const RESET_TOKEN_TTL_MS = 1000 * 60 * 30;

function ensureDatabaseConnection(res) {
  if (isDatabaseConnected()) {
    return true;
  }

  res.status(503).json({
    flag: "0",
    message: "Database is unavailable. Please make sure MongoDB is running.",
  });
  return false;
}

function buildResetTokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function sanitizeBaseUrl(value) {
  const normalizedValue = String(value || "").trim();

  if (!normalizedValue) {
    return "";
  }

  try {
    return new URL(normalizedValue).toString().replace(/\/+$/, "");
  } catch (_error) {
    return "";
  }
}

function buildClientBaseUrl(payload = {}) {
  const preferredBaseUrl =
    sanitizeBaseUrl(payload.frontendBaseUrl) ||
    sanitizeBaseUrl(payload.clientUrl) ||
    sanitizeBaseUrl(payload.appBaseUrl) ||
    sanitizeBaseUrl(payload.origin) ||
    sanitizeBaseUrl(process.env.CLIENT_URL) ||
    sanitizeBaseUrl(process.env.CLIENT_ORIGIN);

  return preferredBaseUrl || "http://localhost:3000";
}

function buildResetLink({ token, email, payload = {} }) {
  const resetLinkBase =
    sanitizeBaseUrl(payload.resetPageUrl) ||
    sanitizeBaseUrl(payload.redirectUrl) ||
    sanitizeBaseUrl(payload.callbackUrl) ||
    sanitizeBaseUrl(payload.resetUrl) ||
    "";
  const resetUrl = new URL(
    resetLinkBase || "/reset-password",
    buildClientBaseUrl(payload),
  );

  if (!resetUrl.pathname || resetUrl.pathname === "/") {
    resetUrl.pathname = "/reset-password";
  }

  resetUrl.searchParams.set("token", token);
  resetUrl.searchParams.set("email", email);
  return resetUrl.toString();
}

function buildForgotPasswordSuccessResponse() {
  return {
    flag: "1",
    message: "A reset link has been sent to your email.",
  };
}

async function storeResetToken(user) {
  const resetToken = crypto.randomBytes(RESET_TOKEN_BYTES).toString("hex");
  await Users.updateOne(
    { _id: user._id },
    {
      $set: {
        passwordResetToken: buildResetTokenHash(resetToken),
        passwordResetExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    },
  );
  return resetToken;
}

async function clearResetToken(user) {
  await Users.updateOne(
    { _id: user._id },
    {
      $set: {
        passwordResetToken: null,
        passwordResetExpiresAt: null,
      },
    },
  );
}

async function sendResetPasswordEmail({ user, resetLink }) {
  const subject = "Reset your password";
  const text = [
    `Hello ${user.name || "User"},`,
    "",
    "We received a request to reset your password.",
    `Use this link to continue: ${resetLink}`,
    "",
    "This link will expire in 30 minutes.",
    "If you did not request this, you can ignore this email.",
  ].join("\n");

  const html = `
    <p>Hello ${user.name || "User"},</p>
    <p>We received a request to reset your password.</p>
    <p><a href="${resetLink}">Reset your password</a></p>
    <p>This link will expire in 30 minutes.</p>
    <p>If you did not request this, you can ignore this email.</p>
  `;

  try {
    return await sendMail({
      to: user.email,
      subject,
      text,
      html,
    });
  } catch (primaryError) {
    const smtpHost = String(process.env.SMTP_HOST || "").trim().toLowerCase();
    const smtpUser = String(process.env.SMTP_USER || "").trim();
    const smtpPass = String(process.env.SMTP_PASS || "").trim();
    const mailFrom = String(process.env.MAIL_FROM || smtpUser).trim();

    if (!smtpUser || !smtpPass) {
      throw primaryError;
    }

    try {
      const fallbackTransporter = nodemailer.createTransport(
        smtpHost === "smtp.gmail.com"
          ? {
              service: "gmail",
              auth: {
                user: smtpUser,
                pass: smtpPass,
              },
            }
          : {
              host: process.env.SMTP_HOST,
              port: Number(process.env.SMTP_PORT || 587),
              secure: String(process.env.SMTP_SECURE || "").trim().toLowerCase() === "true",
              auth: {
                user: smtpUser,
                pass: smtpPass,
              },
              tls: {
                rejectUnauthorized: false,
              },
            },
      );

      await fallbackTransporter.verify();
      return await fallbackTransporter.sendMail({
        from: mailFrom,
        to: user.email,
        subject,
        text,
        html,
      });
    } catch (fallbackError) {
      console.error("Primary reset email send failed:", primaryError.message);
      console.error("Fallback reset email send failed:", fallbackError.message);
      throw fallbackError;
    }
  }
}

router.post(["/password-reset", "/forgot-password"], async (req, res) => {
  const email = normalizeEmail(req.body.email);

  if (!ensureDatabaseConnection(res)) {
    return;
  }

  if (!email) {
    return res
      .status(400)
      .json({ flag: "0", message: "Email is required." });
  }

  try {
    const user = await Users.findOne({
      email: { $regex: `^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
    });

    if (!user) {
      return res.status(200).json(buildForgotPasswordSuccessResponse());
    }

    const resetToken = await storeResetToken(user);
    const resetLink = buildResetLink({
      token: resetToken,
      email: user.email,
      payload: req.body,
    });

    try {
      await sendResetPasswordEmail({ user, resetLink });
    } catch (mailError) {
      console.error("Failed to send password reset email:", mailError);
      if (process.env.NODE_ENV !== "production") {
        return res.status(200).json({
          ...buildForgotPasswordSuccessResponse(),
          message:
            "Email could not be delivered from the server, so a reset link was generated for local development.",
          resetLink,
          devResetLink: resetLink,
          emailSent: false,
        });
      }

      await clearResetToken(user);
      return res.status(500).json({
        flag: "0",
        message: "Failed to send reset email. Please try again later.",
      });
    }

    return res.status(200).json(buildForgotPasswordSuccessResponse());
  } catch (error) {
    console.error("Error in password reset request:", error);
    return res.status(500).json({
      flag: "0",
      message:
        process.env.NODE_ENV === "production"
          ? "Database error"
          : error.message || "Database error",
    });
  }
});

router.post("/reset-password", async (req, res) => {
  if (!ensureDatabaseConnection(res)) {
    return;
  }

  const email = normalizeEmail(req.body.email);
  const token = String(req.body.token || "").trim();
  const newPassword = String(
    req.body.newPassword || req.body.password || req.body.npass || "",
  );
  const confirmPassword = String(
    req.body.confirmPassword || req.body.cpass || req.body.passwordConfirm || "",
  );

  if (!email || !token || !newPassword || !confirmPassword) {
    return res.status(400).json({
      flag: "0",
      message: "Email, token, new password, and confirm password are required.",
    });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({
      flag: "0",
      message: "New password must be at least 6 characters long.",
    });
  }

  if (newPassword !== confirmPassword) {
    return res.status(400).json({
      flag: "0",
      message: "New password and confirm password do not match.",
    });
  }

  try {
    const hashedToken = buildResetTokenHash(token);
    const user = await Users.findOne({
      email,
      passwordResetToken: hashedToken,
      passwordResetExpiresAt: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({
        flag: "0",
        message: "Reset token is invalid or has expired.",
      });
    }

    await Users.updateOne(
      { _id: user._id },
      {
        $set: {
          password: await bcrypt.hash(newPassword, 10),
          passwordResetToken: null,
          passwordResetExpiresAt: null,
          refreshToken: null,
        },
      },
    );

    return res.status(200).json({
      flag: "1",
      message: "Password reset successfully.",
    });
  } catch (error) {
    console.error("Error resetting password:", error);
    return res.status(500).json({
      flag: "0",
      message:
        process.env.NODE_ENV === "production"
          ? "Database error"
          : error.message || "Database error",
    });
  }
});

module.exports = router;
