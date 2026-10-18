/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true,
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  webpack: (config, { isServer }) => {
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, crypto: false };
    // onnxruntime-node .node binaries must not be parsed — treat as external so CDN path is used at runtime
    config.externals = config.externals || [];
    config.externals.push({ 'onnxruntime-node': 'commonjs onnxruntime-node', 'sharp': 'commonjs sharp' });
    // also ignore .node files that slip through (copy as asset, don't parse)
    config.module.rules.push({ test: /\.node$/, type: 'asset/resource', generator: { emit: false } });
    if (!isServer) {
      config.resolve.alias = { ...config.resolve.alias, 'onnxruntime-node': false, 'sharp': false };
    }
    return config;
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        ],
      },
    ];
  },
};
export default nextConfig;
