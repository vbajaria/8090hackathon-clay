import type { NextConfig } from 'next';
const config: NextConfig = { transpilePackages: ['@leadwork/contracts', '@leadwork/engine'], poweredByHeader: false };
export default config;
