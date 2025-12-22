const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const webpack = require('webpack');

module.exports = {
  entry: './src/renderer.js', // We'll create this file
  mode: 'development',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'renderer.js',
    publicPath: './'
  },
  resolve: {
    fallback: {
      "global": false,
      "process": false,
      "Buffer": false
    }
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env']
          }
        }
      },
      {
        test: /\.css$/,
        use: ['style-loader', 'css-loader']
      },
      {
        test: /\.(png|jpg|jpeg|gif|ico|svg)$/,
        type: 'asset/resource',
        generator: {
          filename: '[name][ext]'
        }
      }
    ]
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './src/renderer.html',
      filename: 'index.html',
      inject: 'body'
    }),
    new HtmlWebpackPlugin({
      template: './src/interview-window.html',
      filename: 'interview-window.html',
      inject: false
    }),
    new webpack.DefinePlugin({
      'global': 'globalThis',
      'process.env': JSON.stringify(process.env)
    })
  ],
  devServer: {
    static: {
      directory: path.join(__dirname, 'dist'),
    },
    port: 8080,
    hot: true,
    headers: {
      'Access-Control-Allow-Origin': '*',
    }
  },
  target: 'electron-renderer'
};