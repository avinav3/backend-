const express = require("express");
const mongoose = require("mongoose");
const Favorite = require("../models/Favorite");
const CarListing = require("../models/CarListing");
const { authenticateAccessToken } = require("../middleware/auth");

const router = express.Router();

const categoryToRentList = {
  buy: "List",
  rent: "Rent",
};

const categoryAliases = {
  buy: "buy",
  list: "buy",
  sale: "buy",
  rent: "rent",
  rental: "rent",
};

function normalizeCategory(category) {
  if (typeof category !== "string") {
    return "";
  }

  const normalizedCategory = category.trim().toLowerCase();
  return categoryAliases[normalizedCategory] || "";
}

function isValidCategory(category) {
  return Object.prototype.hasOwnProperty.call(categoryToRentList, category);
}

async function findListingByCarIdAndCategory(carId, category) {
  const listingFilter = { RentList: categoryToRentList[category] };

  if (mongoose.Types.ObjectId.isValid(carId)) {
    const listingByObjectId = await CarListing.findOne({
      ...listingFilter,
      _id: carId,
    }).lean();

    if (listingByObjectId) {
      return listingByObjectId;
    }
  }

  return CarListing.findOne({
    ...listingFilter,
    listing_id: Number.isNaN(Number(carId)) ? -1 : Number(carId),
  }).lean();
}

function extractCarId(source) {
  const candidate =
    source?.carId ??
    source?.listingId ??
    source?.listing_id ??
    source?.car_id ??
    source?.id ??
    "";

  return String(candidate).trim();
}

function buildFavoriteResponse(favorite, listing) {
  return {
    id: favorite._id,
    user: favorite.user,
    carId: favorite.carId,
    listingId: favorite.carId,
    category: favorite.category,
    createdAt: favorite.createdAt,
    updatedAt: favorite.updatedAt,
    car: listing
      ? {
          id: listing._id,
          listing_id: listing.listing_id,
          make: listing.make,
          model: listing.model,
          year: listing.year,
          price: listing.price,
          location: listing.location,
          RentList: listing.RentList,
          listing_status: listing.listing_status,
          images: listing.images || [],
        }
      : null,
  };
}

async function toggleFavorite(req, res) {
  const carId = extractCarId(req.body);
  const category = normalizeCategory(req.body.category);

  if (!carId) {
    return res.status(400).json({
      flag: "0",
      message: "carId is required.",
    });
  }

  if (!isValidCategory(category)) {
    return res.status(400).json({
      flag: "0",
      message: 'category must be either "buy" or "rent".',
    });
  }

  try {
    const listing = await findListingByCarIdAndCategory(carId, category);

    if (!listing) {
      return res.status(404).json({
        flag: "0",
        message: "Listing not found for the selected category.",
      });
    }

    const existingFavorite = await Favorite.findOne({
      user: req.auth.id,
      carId,
      category,
    });

    if (existingFavorite) {
      await Favorite.deleteOne({ _id: existingFavorite._id });

      return res.status(200).json({
        flag: "1",
        message: "Favorite removed successfully.",
        isFavorited: false,
        action: "removed",
        favorite: null,
      });
    }

    const favorite = await Favorite.create({
      user: req.auth.id,
      carId,
      category,
    });

    return res.status(201).json({
      flag: "1",
      message: "Favorite added successfully.",
      isFavorited: true,
      favorited: true,
      action: "added",
      favorite: buildFavoriteResponse(favorite, listing),
    });
  } catch (error) {
    console.error("Error toggling favorite:", error);
    return res.status(500).json({
      flag: "0",
      message: "Failed to update favorite.",
    });
  }
}

async function getMyFavorites(req, res) {
  try {
    const favorites = await Favorite.find({ user: req.auth.id })
      .sort({ createdAt: -1 })
      .lean();

    const favoritesWithCars = await Promise.all(
      favorites.map(async (favorite) => {
        const listing = await findListingByCarIdAndCategory(
          favorite.carId,
          favorite.category
        );

        return buildFavoriteResponse(favorite, listing);
      })
    );

    return res.status(200).json({
      flag: "1",
      count: favoritesWithCars.length,
      favorites: favoritesWithCars,
      items: favoritesWithCars,
      data: favoritesWithCars,
    });
  } catch (error) {
    console.error("Error fetching favorites:", error);
    return res.status(500).json({
      flag: "0",
      message: "Failed to fetch favorites.",
    });
  }
}

async function removeFavorite(req, res) {
    const carId = extractCarId(req.params);
    const category = normalizeCategory(req.params.category);

    if (!carId) {
      return res.status(400).json({
        flag: "0",
        message: "carId is required.",
      });
    }

    if (!isValidCategory(category)) {
      return res.status(400).json({
        flag: "0",
        message: 'category must be either "buy" or "rent".',
      });
    }

    try {
      const deletedFavorite = await Favorite.findOneAndDelete({
        user: req.auth.id,
        carId,
        category,
      });

      if (!deletedFavorite) {
        return res.status(404).json({
          flag: "0",
          message: "Favorite not found.",
        });
      }

      return res.status(200).json({
        flag: "1",
        message: "Favorite removed successfully.",
        isFavorited: false,
        favorited: false,
      });
    } catch (error) {
      console.error("Error removing favorite:", error);
      return res.status(500).json({
        flag: "0",
        message: "Failed to remove favorite.",
      });
    }
}

// ## Support both `/api/...` and `/...` route styles so the current frontend keeps working.
router.post("/api/favorites/toggle", authenticateAccessToken, toggleFavorite);
router.post("/favorites/toggle", authenticateAccessToken, toggleFavorite);
router.get("/api/favorites/my", authenticateAccessToken, getMyFavorites);
router.get("/favorites/my", authenticateAccessToken, getMyFavorites);
router.delete(
  "/api/favorites/remove/:carId/:category",
  authenticateAccessToken,
  removeFavorite
);
router.delete(
  "/favorites/remove/:carId/:category",
  authenticateAccessToken,
  removeFavorite
);

module.exports = router;
