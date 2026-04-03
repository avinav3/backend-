const jwt = require("jsonwebtoken");

const ACCESS_COOKIE_NAME = "accessToken";
const REFRESH_COOKIE_NAME = "refreshToken";

function parseDurationToMs(value, fallback) {
  if (!value || typeof value !== "string") {
    return fallback;
  }

  const trimmedValue = value.trim();
  const match = trimmedValue.match(/^(\d+)(ms|s|m|h|d)?$/i);

  if (!match) {
    return fallback;
  }

  const amount = Number(match[1]);
  const unit = (match[2] || "ms").toLowerCase();

  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return amount * (multipliers[unit] || 1);
}

function getAccessTokenExpiresIn() {
  return process.env.ACCESS_TOKEN_EXPIRES || "15m";
}

function getRefreshTokenExpiresIn() {
  return process.env.REFRESH_TOKEN_EXPIRES || "7d";
}

function getAccessTokenSecret() {
  return (
    process.env.ACCESS_TOKEN_SECRET ||
    process.env.JWT_ACCESS_SECRET ||
    "local-access-secret-change-me"
  );
}

function getRefreshTokenSecret() {
  return (
    process.env.REFRESH_TOKEN_SECRET ||
    process.env.JWT_REFRESH_SECRET ||
    "local-refresh-secret-change-me"
  );
}

function buildAuthPayload(account, accountType) {
  return {
    id: account._id.toString(),
    email: account.email,
    role: account.role || (accountType === "admin" ? "admin" : "user"),
    accountType,
  };
}

function generateAccessToken(payload) {
  return jwt.sign(payload, getAccessTokenSecret(), {
    expiresIn: getAccessTokenExpiresIn(),
  });
}

function generateRefreshToken(payload) {
  return jwt.sign(payload, getRefreshTokenSecret(), {
    expiresIn: getRefreshTokenExpiresIn(),
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, getAccessTokenSecret());
}

function verifyRefreshToken(token) {
  return jwt.verify(token, getRefreshTokenSecret());
}

function getRefreshTokenCookieOptions() {
  const isProduction = process.env.NODE_ENV === "production";

  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: parseDurationToMs(getRefreshTokenExpiresIn(), 7 * 24 * 60 * 60 * 1000),
  };
}

function getAccessTokenCookieOptions() {
  const isProduction = process.env.NODE_ENV === "production";

  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: parseDurationToMs(getAccessTokenExpiresIn(), 15 * 60 * 1000),
  };
}

function setAccessTokenCookie(res, accessToken) {
  res.cookie(ACCESS_COOKIE_NAME, accessToken, getAccessTokenCookieOptions());
}

function clearAccessTokenCookie(res) {
  res.clearCookie(ACCESS_COOKIE_NAME, getAccessTokenCookieOptions());
}

function setRefreshTokenCookie(res, refreshToken) {
  res.cookie(
    REFRESH_COOKIE_NAME,
    refreshToken,
    getRefreshTokenCookieOptions()
  );
}

function clearRefreshTokenCookie(res) {
  res.clearCookie(REFRESH_COOKIE_NAME, getRefreshTokenCookieOptions());
}

module.exports = {
  ACCESS_TOKEN_EXPIRES_IN: getAccessTokenExpiresIn(),
  REFRESH_TOKEN_EXPIRES_IN: getRefreshTokenExpiresIn(),
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  buildAuthPayload,
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  setAccessTokenCookie,
  clearAccessTokenCookie,
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
};
