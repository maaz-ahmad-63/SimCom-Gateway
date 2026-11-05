/** @type {import('next').NextConfig} */
const packaging = process.env.SIMGW_PACKAGE_BUILD === '1';

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@sim-gateway/shared'],
  // The customer package is built into its own folder as a self-contained server, so building it never disturbs a running
  // development server (which uses .next) and the installed product needs no npm and no Node installation of its own.
  ...(packaging ? { output: 'standalone', distDir: '.next-package' } : {}),
};

export default nextConfig;
