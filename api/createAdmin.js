const mongoose = require("./db"); // use db.js for shared connection
const bcrypt = require("bcrypt");
const Admin = require("./models/Admin");

// Get command line args
const [name, email, password] = process.argv.slice(2);

if (!name || !email || !password) {
  console.log("Usage: node createAdmin.js <name> <email> <password>");
  console.log(
    "Example: node createAdmin.js 'Admin User' admin@example.com mypassword123"
  );
  process.exit(1);
}

async function createAdminUser() {
  try {
    const existingAdmin = await Admin.findOne({ email });
    if (existingAdmin) {
      console.log("Admin already exists with this email.");
      process.exit(1);
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const adminUser = new Admin({
      name,
      email,
      mobile: "0000000000", // You can modify this to accept phone later
      password: hashedPassword,
      isAdmin: true,
    });

    await adminUser.save();
    console.log("✅ Admin registration successful.");
  } catch (error) {
    console.error("❌ Error during registration:", error);
  } finally {
    mongoose.connection.close();
  }
}

createAdminUser();
