module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Única raíz de tests: test/ (coherente con cdk.json `watch.exclude` y .gitignore).
  roots: ['<rootDir>/test'],
  testMatch: ['**/?(*.)+(spec|test).ts?(x)'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/index.ts'],
  coveragePathIgnorePatterns: ['/node_modules/'],
};
