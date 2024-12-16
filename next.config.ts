import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "hip-lemur-740.convex.cloud",
      },
      {
        protocol: "https",
        hostname: "tame-hamster-542.convex.cloud",
      },
    ],
  },
};

export default nextConfig;
