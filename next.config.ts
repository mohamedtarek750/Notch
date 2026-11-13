import type { NextConfig } from "next";
const config: NextConfig = {
  devIndicators: false,
  allowedDevOrigins: ["127.0.0.1"],
  // Keep Node WebSocket optional native modules under native Node resolution.
  // Bundling ws can replace a missing bufferutil dependency with an empty module.
  serverExternalPackages: [
    "pg",
    "@electric-sql/pglite",
    "pdfjs-dist",
    "ws",
    "@neondatabase/serverless",
  ],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};
export default config;
