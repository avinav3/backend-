const express = require("express");
const bcrypt = require("bcrypt");
const { isDatabaseConnected } = require("../db");
const Users = require("../models/Users");
const Admin = require("../models/Admin");
const { authenticateAccessToken } = require("../middleware/auth");
const {
  REFRESH_COOKIE_NAME,
  buildAuthPayload,
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  setAccessTokenCookie,
  clearAccessTokenCookie,
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
} = require("../utils/token");

const router = express.Router();

function ensureDatabaseConnection(res) {
  if (isDatabaseConnected()) {
    return true;
  }

  res.status(503).json({
    flag: "0",
    message: "Database is unavailable. Please try again later.",
  });
  return false;
}

function sanitizeAccount(account, accountType) {
  return {
    id: account._id,
    name: account.name,
    email: account.email,
    role: account.role || (accountType === "admin" ? "admin" : "user"),
    accountType,
    profileImage: account.profileImage || null,
  };
}

function getModelByAccountType(accountType) {
  return accountType === "admin" ? Admin : Users;
}

async function issueTokensAndPersist(account, accountType) {
  const payload = buildAuthPayload(account, accountType);
  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload);

  account.refreshToken = refreshToken;
  account.lastLogin = new Date();
  await account.save();

  return { accessToken, refreshToken, user: sanitizeAccount(account, accountType) };
}

async function handleLogin(req, res, options) {
  const { email, password } = req.body;

  if (!ensureDatabaseConnection(res)) {
    return;
  }

  try {
    const account = await options.model.findOne({ email });

    if (!account) {
      return res.json({ flag: "0", message: "Invalid email or password." });
    }

    if (options.accountType === "user" && account.status !== "active") {
      return res
        .status(403)
        .json({ flag: "0", message: "Your account is not active." });
    }

    const passwordMatch = await bcrypt.compare(password, account.password);

    if (!passwordMatch) {
      return res.json({ flag: "0", message: "Invalid email or password." });
    }

    const { accessToken, refreshToken, user } = await issueTokensAndPersist(
      account,
      options.accountType
    );

    setAccessTokenCookie(res, accessToken);
    setRefreshTokenCookie(res, refreshToken);

    return res.json({
      flag: "1",
      name: account.name,
      id: account._id,
      role: user.role,
      accessToken,
      user,
    });
  } catch (error) {
    console.error(`${options.accountType} login error:`, error);
    return res.status(500).json({ flag: "0", message: "Database error" });
  }
}

router.post("/login", async (req, res) => {
  return handleLogin(req, res, { model: Users, accountType: "user" });
});

router.post("/api/admin/login", async (req, res) => {
  return handleLogin(req, res, { model: Admin, accountType: "admin" });
});

router.post("/auth/refresh", async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];

  if (!refreshToken) {
    return res
      .status(401)
      .json({ flag: "0", message: "Refresh token is required." });
  }

  if (!ensureDatabaseConnection(res)) {
    return;
  }

  try {
    const decoded = verifyRefreshToken(refreshToken);
    const Model = getModelByAccountType(decoded.accountType);
    const account = await Model.findById(decoded.id);

    if (!account || account.refreshToken !== refreshToken) {
      return res
        .status(401)
        .json({ flag: "0", message: "Invalid refresh token." });
    }

    if (decoded.accountType === "user" && account.status !== "active") {
      account.refreshToken = null;
      await account.save();
      clearRefreshTokenCookie(res);
      return res
        .status(403)
        .json({ flag: "0", message: "Your account is not active." });
    }

    const { accessToken, refreshToken: rotatedToken, user } =
      await issueTokensAndPersist(account, decoded.accountType);

    setAccessTokenCookie(res, accessToken);
    setRefreshTokenCookie(res, rotatedToken);

    return res.json({
      flag: "1",
      accessToken,
      user,
    });
  } catch (error) {
    clearAccessTokenCookie(res);
    clearRefreshTokenCookie(res);
    return res
      .status(401)
      .json({ flag: "0", message: "Invalid or expired refresh token." });
  }
});

router.post("/auth/logout", async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];

  if (!ensureDatabaseConnection(res)) {
    clearAccessTokenCookie(res);
    clearRefreshTokenCookie(res);
    return res.status(503).json({
      flag: "0",
      message: "Database is unavailable. Please try again later.",
    });
  }

  try {
    if (refreshToken) {
      try {
        const decoded = verifyRefreshToken(refreshToken);
        const Model = getModelByAccountType(decoded.accountType);
        await Model.findByIdAndUpdate(decoded.id, { refreshToken: null });
      } catch (error) {
        await Promise.all([
          Users.updateOne({ refreshToken }, { refreshToken: null }),
          Admin.updateOne({ refreshToken }, { refreshToken: null }),
        ]);
      }
    }

    clearRefreshTokenCookie(res);
    clearAccessTokenCookie(res);
    return res.json({ flag: "1", message: "Logged out successfully." });
  } catch (error) {
    console.error("Logout error:", error);
    clearRefreshTokenCookie(res);
    clearAccessTokenCookie(res);
    return res.status(500).json({ flag: "0", message: "Database error" });
  }
});

router.get("/auth/me", authenticateAccessToken, async (req, res) => {
  if (!ensureDatabaseConnection(res)) {
    return;
  }

  try {
    const Model = getModelByAccountType(req.auth.accountType);
    const account = await Model.findById(req.auth.id);

    if (!account) {
      return res.status(404).json({ flag: "0", message: "User not found." });
    }

    if (req.auth.accountType === "user" && account.status !== "active") {
      return res
        .status(403)
        .json({ flag: "0", message: "Your account is not active." });
    }

    return res.json({
      flag: "1",
      user: sanitizeAccount(account, req.auth.accountType),
    });
  } catch (error) {
    console.error("Fetch current user error:", error);
    return res.status(500).json({ flag: "0", message: "Database error" });
  }
});

module.exports = router;
