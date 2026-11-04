// Devvit release the generated projects are tested against. Pinned instead of
// "latest" so a new Devvit release can't silently break an existing port.
export const DEVVIT_VERSION = '0.15.1';
// SQLite (WebAssembly) used to run WebSim server.js databases on Devvit.
export const SQLJS_VERSION = '1.13.0';

// devvit.json `name`: 3-20 chars, starts with a letter, lowercase letters, digits, hyphens.
export const APP_NAME_PATTERN = /^[a-z][a-z0-9-]{2,19}$/;

export const generatePackageJson = (slug, dependencies = {}, devDependencies = {}) => JSON.stringify({
  "name": slug,
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "devvit playtest",
    "build:client": "cd src/client && vite build",
    "build:server": "cd src/server && vite build",
    "build": "npm run build:server && npm run build:client",
    "watch": "npm run build:server && cd src/client && vite build --watch",
    "setup": "node scripts/setup.js",
    "register": "devvit upload",
    "upload": "devvit upload",
    "pull": "node scripts/pull.mjs",
    "validate": "node scripts/validate.js"
  },
  "dependencies": {
    "@devvit/web": DEVVIT_VERSION,
    "express": "^4.21.2",
    ...dependencies
  },
  "devDependencies": {
    "devvit": DEVVIT_VERSION,
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "terser": "^5.36.0",
    "@vitejs/plugin-react": "^4.3.0",
    "@babel/core": "^7.26.0",
    "@babel/preset-react": "^7.26.0",
    ...devDependencies
  },
  "engines": {
    "node": ">=22.2.0"
  }
}, null, 2);

// options.media: the game calls websim.upload, so images go to Reddit's media CDN.
// options.httpDomains / options.secrets: from the port doctor's look at server.js.
export const generateDevvitJson = (slug, entrypoints, enablePayments = true, options = {}) => {
  const config = {
    "$schema": "https://developers.reddit.com/schema/config-file.v1.json",
    "name": slug,
    "post": {
      "dir": "dist/client",
      "entrypoints": entrypoints || {
        "default": {
          "entry": "index.html",
          "height": "tall"
        }
      }
    },

    "server": {
      "dir": "dist/server",
      "entry": "index.cjs"
    },
    "permissions": {
      "redis": true,
      "realtime": true,
      "payments": enablePayments,
      "media": !!options.media,
      "reddit": {
        "enable": true,
        "asUser": ["SUBMIT_POST", "SUBMIT_COMMENT"]
      }
    },
    // The Devvit CLI runs these itself, so `devvit upload` and `devvit playtest`
    // always ship a fresh build.
    "scripts": {
      "dev": "npm run watch",
      "build": "npm run build"
    },
    "triggers": {
      "onAppInstall": "/internal/onInstall"
    },
    "menu": {
      "items": [
        {
          "label": "Add Game Post",
          "location": "subreddit",
          "forUserType": "moderator",
          "endpoint": "/internal/createPost"
        }
      ]
    }
  };

  // server.js fetches other sites: Reddit reviews each domain on upload.
  if (options.httpDomains?.length) config.permissions.http = { "enable": true, "domains": options.httpDomains };
  // env.SECRETS.get(name) in server.js: app secrets, set with `npx devvit settings set <name>`.
  if (options.secrets?.length) {
    config.settings = { "global": {} };
    for (const name of options.secrets) config.settings.global[name] = { "type": "string", "label": name, "isSecret": true }; // Devvit's schema forbids a defaultValue on secrets
  }

  if (enablePayments) {
    config.media = {
      "dir": "assets"
    };
    config.payments = {
      "productsFile": "products.json",
      "endpoints": {
        "fulfillOrder": "/internal/payments/fulfill",
        "refundOrder": "/internal/payments/refund"
      }
    };
  }

  return JSON.stringify(config, null, 2);
};

export const generateClientViteConfig = ({ hasReact = false, hasRemotion = false, inputs = {} } = {}) => `
import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

${hasReact ? "import react from '@vitejs/plugin-react';" : ""}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  mode: 'production',
  base: './',
  plugins: [
    ${hasReact ? `react({
      jsxRuntime: 'automatic', 
      jsxImportSource: 'react',
      include: "**/*.{jsx,tsx,js,ts}",
      babel: {
        babelrc: false,
        configFile: false,
        plugins: [],
        compact: true // ← ADD THIS: Ensures no eval in output
      }
    }),` : ''}
  ],
  resolve: {
    alias: {
      'react/jsx-dev-runtime': path.resolve(__dirname, './jsx-dev-proxy.js'),
      'react/jsx-runtime': 'react/jsx-runtime',
      'remotion': 'remotion',
      'websim': path.resolve(__dirname, './websim_package.js'),
      '@protobufjs/inquire': path.resolve(__dirname, './protobuf-inquire-stub.js'),
      'protobufjs/inquire': path.resolve(__dirname, './protobuf-inquire-stub.js')
    },
    extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
    mainFields: ['browser', 'module', 'main'],
  },
  assetsInclude: ['**/*.mp3', '**/*.wav', '**/*.ogg', '**/*.glb', '**/*.gltf', '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif'],
  esbuild: {
    loader: 'jsx',
    include: /\.(js|jsx|ts|tsx)$/, // regex fix
    exclude: [],
    legalComments: 'none', 
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    // Reddit's webviews are current browsers; es2022 allows top-level await,
    // which many Websim games use while loading.
    target: 'es2022',
    minify: 'terser', // ← CHANGE FROM esbuild to terser for better CSP compliance
    terserOptions: {
      compress: {
        drop_console: false,
        pure_funcs: [],
        ecma: 2020,
        passes: 2
      },
      format: {
        comments: false,
        ecma: 2020
      },
      module: true,
      toplevel: true,
      safari10: true
    },
    sourcemap: false,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      ${Object.keys(inputs).length > 0 ? `input: ${JSON.stringify(inputs)},` : ''}
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
        format: 'es', // ← ADD THIS: Force ES modules (no eval)
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules/remotion') || id.includes('node_modules/@remotion')) return 'remotion';
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) return 'react-vendor';
        }
      },
      external: [], 
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "process.platform": JSON.stringify("browser"),
    "process.env.REMOTION_ENV": JSON.stringify("production"),
    "__REACT_DEVTOOLS_GLOBAL_HOOK__": JSON.stringify({ isDisabled: true }),
    "process.env.REMOTION_DISABLE_STUDIO": JSON.stringify("true"),
    "global": "globalThis",
  },
  optimizeDeps: {
    include: [${hasReact ? "'react', 'react-dom', 'react/jsx-runtime'" : ""}, ${hasRemotion ? "'remotion', '@remotion/player'" : ""}],
    esbuildOptions: {
      target: 'es2022',
      legalComments: 'none' // ← ADD THIS
    }
  }
});
`;

export const tsConfig = JSON.stringify({
  "compilerOptions": {
    "target": "es2020",
    "module": "es2020",
    "moduleResolution": "node",
    "lib": ["es2020", "dom"],
    "jsx": "react-jsx",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "noImplicitAny": false,
    "allowJs": true
  },
  "include": [
    "src"
  ]
}, null, 2);

// options.websimServer: inline sql.js's WebAssembly at build time (the Devvit
// server can't read files at runtime) as the module 'virtual:sqljs-wasm'.
export const generateServerViteConfig = (options = {}) => `
import { defineConfig } from 'vite';
import { builtinModules, createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
${options.websimServer ? `
const require = createRequire(import.meta.url);
const sqljsWasm = () => ({
  name: 'sqljs-wasm',
  resolveId(id) { return id === 'virtual:sqljs-wasm' ? '\\0sqljs-wasm' : null; },
  load(id) {
    if (id !== '\\0sqljs-wasm') return null;
    const wasm = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
    return 'export default ' + JSON.stringify(wasm.toString('base64')) + ';';
  },
  // sql.js sets \`module = undefined\` and guards one emscripten line with
  // typeof module; bundling turns that check into a constant, so drop the line.
  transform(code, id) {
    if (!id.includes('sql.js/dist/sql-wasm.js')) return null;
    return code.replace('"undefined"!=typeof module&&(module.exports=f);', '');
  },
});
` : ''}
export default defineConfig({
  ${options.websimServer ? 'plugins: [sqljsWasm()],' : ''}
  ssr: {
    noExternal: true,
  },
  build: {
    ssr: 'index.ts',
    outDir: '../../dist/server',
    target: 'node22',
    sourcemap: true,
    emptyOutDir: true,
    rollupOptions: {
      external: [...builtinModules],
      output: {
        format: 'cjs',
        entryFileNames: 'index.cjs',
        inlineDynamicImports: true,
      },
      onwarn(warning, warn) {
        // Suppress "Use of eval" warning from protobufjs/inquire which is common in devvit/google protos
        if (warning.code === 'EVAL' && warning.id.includes('protobufjs')) return;
        warn(warning);
      },
    },
  },
});
`;

