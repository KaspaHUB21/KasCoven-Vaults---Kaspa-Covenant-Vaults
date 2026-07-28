import path from "node:path";

const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.resolve("."),
  turbopack: {
    root: path.resolve("."),
  },
};

export default nextConfig;
