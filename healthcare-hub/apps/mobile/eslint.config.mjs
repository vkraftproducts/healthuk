import { baseConfig } from '@hub/config/eslint';

export default [
  ...baseConfig(),
  { ignores: ['.expo/**', 'android/**', 'ios/**', 'babel.config.js'] },
];
