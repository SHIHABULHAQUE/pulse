import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Dev server is reachable from other machines on the LAN.
// HTTPS (self-signed) is required because WebCrypto (crypto.subtle) only works in secure contexts,
// and the WebSocket is proxied through /ws so clients only need this one port.
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true,
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } }
  }
});
