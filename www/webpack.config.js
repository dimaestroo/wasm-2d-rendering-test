const CopyWebpackPlugin = require("copy-webpack-plugin");
const path = require("path");

module.exports = {
  mode: "development",

  entry: "./bootstrap.js",

  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "bootstrap.js",
    clean: true,
  },

  experiments: {
    asyncWebAssembly: true,
  },

  module: {
    rules: [
      {
        test: /\.wasm$/,
        type: "webassembly/async",
      },
    ],
  },

  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: "index.html", to: "index.html" },
      ],
    }),
  ],

  devServer: {
    static: {
      directory: path.resolve(__dirname, "dist"),
    },
  },
};