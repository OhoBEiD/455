# DES Visualization Studio

An interactive React + TypeScript lab that teaches every step of the Data Encryption Standard (DES) algorithm with Tailwind-driven visuals, React Flow diagrams, step mode playback, avalanche demos, and curated presets.

## Development

```bash
npm install
npm run dev
```

This starts Vite on the default port. The UI reflects changes instantly (HMR enabled).

## Building

```bash
npm run build
```

Uses TypeScript project refs plus Vite to emit an optimized `/dist` bundle.

## Testing the DES algorithm

Unit tests exercise the DES core with official NIST vectors, the classroom sample from the UI presets, parity/key-schedule checks, and a basic avalanche probe.

```bash
npm run test
```

Feel free to extend `src/lib/des.test.ts` with additional scenarios (e.g., triple-DES chains, more weak-key permutations, or random fuzz cases) to further validate the cipher logic.
