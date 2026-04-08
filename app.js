// app.js
const fs = require("fs");
const path = require("path");

function loadLocalEnv() {
  const envPath = path.join(__dirname, ".env");

  if (!fs.existsSync(envPath)) {
    return;
  }

  const envFile = fs.readFileSync(envPath, "utf8");

  envFile.split(/\r?\n/).forEach((line) => {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      return;
    }

    const separatorIndex = trimmedLine.indexOf("=");

    if (separatorIndex === -1) {
      return;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const rawValue = trimmedLine.slice(separatorIndex + 1).trim();
    const normalizedValue = rawValue.replace(/^['"]|['"]$/g, "");

    if (key && process.env[key] === undefined) {
      process.env[key] = normalizedValue;
    }
  });
}

loadLocalEnv();
require("./db"); // MongoDB connection

const express = require("express");
const http = require("http");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { Server } = require("socket.io");
const { verifyAccessToken } = require("./utils/token");
const { setIo } = require("./utils/socket");
const app = express();
const server = http.createServer(app);

const listingsRouter = require("./api/listings");
const bidRoutes = require("./api/bidRoutes"); // Adjust path if needed
const bookingRoutes = require("./api/bookings");
const paymentRoutes = require("./api/payments");
const deleteUserRoute = require("./api/deleteUser");
const photoUploadRoutes = require("./api/listings");
const reviewRoutes = require("./api/reviews"); // Import the review routes
const reportGenerate = require("./api/report-generate"); // Import the report generation file
const authRoutes = require("./api/auth");
const favoriteRoutes = require("./api/favorites");
app.set("etag", false);

const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function isOriginAllowed(origin) {
  if (!origin) {
    return true;
  }

  return allowedOrigins.includes(origin);
}

// Middleware
app.use(
  cors({
    origin(origin, callback) {
      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }

      return callback(new Error("CORS origin not allowed"));
    },
    credentials: true,
  }),
);
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api/reports", reportGenerate); // Mount the report generation functionality
// ## Serve uploaded assets so profile images can be displayed by the frontend.
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/api", reviewRoutes); // Mount review routes under `/api`
// Routes
app.use(require("./api/password-reset"));
app.use(require("./api/register"));
app.use(authRoutes);
app.use(require("./api/change-password"));
app.use(require("./api/update-profile"));
app.use(favoriteRoutes);
// app.use(require('./api/carListing'));
app.use("/api/listings", listingsRouter);
app.use("/api", bidRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/payments", paymentRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api", deleteUserRoute);
app.use("/api/upload", photoUploadRoutes);
app.use("/api/messages", require("./api/messages/sendmessage"));

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || "127.0.0.1";

const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Socket origin not allowed"));
    },
    credentials: true,
  },
});

setIo(io);

io.use((socket, next) => {
  try {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.query?.token ||
      socket.handshake.headers.authorization?.replace(/^Bearer\s+/i, "") ||
      socket.handshake.headers["x-access-token"] ||
      null;

    if (!token) {
      return next(new Error("Authentication required"));
    }

    socket.auth = verifyAccessToken(token);
    return next();
  } catch (error) {
    return next(new Error("Invalid or expired token"));
  }
});

io.on("connection", (socket) => {
  const role = socket.auth?.role === "admin" ? "admin" : "user";
  const authId = String(socket.auth?.id || "");

  if (!authId) {
    socket.disconnect(true);
    return;
  }

  // Join both canonical and legacy-friendly room names so chat delivery stays
  // stable even if different frontend builds subscribe to different aliases.
  socket.join(`user:${authId}`);
  socket.join(`user_${authId}`);

  if (role === "admin") {
    socket.join("admins");
    socket.join(`admin:${authId}`);
    socket.join(`admin_${authId}`);
  }

  socket.on("chat:join", (payload = {}) => {
    if (payload.conversationId) {
      socket.join(`conversation:${payload.conversationId}`);
      socket.join(`conversation_${payload.conversationId}`);
    }
  });

  socket.on("chat:join-conversation", (payload = {}) => {
    if (payload.conversationId) {
      socket.join(`conversation:${payload.conversationId}`);
      socket.join(`conversation_${payload.conversationId}`);
    }
  });

  socket.on("chat:join-admin", () => {
    if (role === "admin") {
      socket.join("admins");
    }
  });

  socket.on("chat:leave", (payload = {}) => {
    if (payload.conversationId) {
      socket.leave(`conversation:${payload.conversationId}`);
      socket.leave(`conversation_${payload.conversationId}`);
    }
  });

  socket.on("chat:leave-conversation", (payload = {}) => {
    if (payload.conversationId) {
      socket.leave(`conversation:${payload.conversationId}`);
      socket.leave(`conversation_${payload.conversationId}`);
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
});

server.on("error", (error) => {
  console.error("Failed to start server:", error.message);
});
