const { ACCESS_COOKIE_NAME, verifyAccessToken } = require("../utils/token");

function extractAccessToken(req) {
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;

  return (
    bearerToken ||
    req.headers["x-access-token"] ||
    req.cookies?.[ACCESS_COOKIE_NAME] ||
    req.body?.accessToken ||
    req.body?.token ||
    null
  );
}

function authenticateAccessToken(req, res, next) {
  const token = extractAccessToken(req);

  if (!token) {
    return res
      .status(401)
      .json({
        flag: "0",
        message:
          "Authentication required. Send a valid access token in the Authorization header or auth cookie.",
      });
  }

  try {
    req.auth = verifyAccessToken(token);
    return next();
  } catch (error) {
    return res
      .status(401)
      .json({ flag: "0", message: "Invalid or expired access token." });
  }
}

function requireAdmin(req, res, next) {
  if (req.auth?.role !== "admin") {
    return res
      .status(403)
      .json({ flag: "0", message: "Admin access is required." });
  }

  return next();
}

module.exports = {
  extractAccessToken,
  authenticateAccessToken,
  requireAdmin,
};
