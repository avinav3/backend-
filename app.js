// app.js
require("./db"); // MongoDB connection

const express = require("express");
const mongoose = require("mongoose");
const bodyParser = require("body-parser");
const cors = require("cors");
const app = express();

const path = require("path");
const listingsRouter = require("./api/listings");
const bidRoutes = require("./api/bidRoutes"); // Adjust path if needed
const bookingRoutes = require("./api/bookings");
const paymentRoutes = require("./api/payments");
const adminLoginRoutes = require("./api/adminLogin");
const deleteUserRoute = require("./api/deleteUser");
const photoUploadRoutes = require("./api/listings");
const reviewRoutes = require("./api/reviews"); // Import the review routes
const reportGenerate = require("./api/report-generate"); // Import the report generation file

// Middleware
app.use(cors());
app.use(express.json()); // To parse JSON request bodies
app.use(express.urlencoded({ extended: true }));
app.use("/api/reports", reportGenerate); // Mount the report generation functionality
// Serve static files from uploads directory
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/api", reviewRoutes); // Mount review routes under `/api`
// Routes
app.use(require("./api/password-reset"));
// app.use(require('./api/login'));
app.use(require("./api/register"));
app.use(require("./api/change-password"));
app.use(require("./api/update-profile"));
// app.use(require('./api/carListing'));
app.use("/api/listings", listingsRouter);
app.use("/api", bidRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/payments", paymentRoutes);
app.use("/api", deleteUserRoute);
app.use("/api/admin", adminLoginRoutes); // Admin login
app.use("/api/upload", photoUploadRoutes);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
