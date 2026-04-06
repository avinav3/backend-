// app.js
require("./db"); // MongoDB connection

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const app = express();

const path = require("path");
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

// Middleware
app.use(
  cors({
    origin: "http://localhost:3000",
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
app.use("/api", deleteUserRoute);
app.use("/api/upload", photoUploadRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
