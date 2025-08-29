require("dotenv").config({ path: "/home/ubuntu/Question-Mark-Bot/.env" });

module.exports = {
  apps: [
    {
      name: "solomon",
      script: "server.js",
      cwd: "/home/ubuntu/Question-Mark-Bot",
      watch: false,
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 10000,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        DATABASE_URL: process.env.DATABASE_URL,
        LEAD_EMAIL_USER: process.env.LEAD_EMAIL_USER,
        LEAD_EMAIL_PASS: process.env.LEAD_EMAIL_PASS,
        LEAD_EMAIL_TO: process.env.LEAD_EMAIL_TO,
        TENANT: process.env.TENANT,
        ADMIN_KEY: process.env.ADMIN_KEY,
        BRAND_COLOR: process.env.BRAND_COLOR,
        BRAND_HOVER: process.env.BRAND_HOVER,
        BOT_BG: process.env.BOT_BG,
        BOT_TEXT: process.env.BOT_TEXT,
        USER_BG: process.env.USER_BG,
        USER_TEXT: process.env.USER_TEXT
      }
    }
  ]
};
