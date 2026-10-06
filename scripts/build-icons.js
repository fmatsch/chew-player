// Rasterises the SVG logo into the PNG icons used by the app, the builder and the website.
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const render = (svgPath, size, outPath) => {
  const png = new Resvg(readFileSync(svgPath), { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(outPath, png);
  console.log(`wrote ${outPath} (${size}px)`);
};

render('assets/icon.svg', 1024, 'build/icon.png');
render('assets/icon.svg', 256, 'assets/icon.png');
render('assets/logo.svg', 512, 'docs/logo.png');
render('assets/icon.svg', 180, 'docs/apple-touch-icon.png');
copyFileSync('assets/logo.svg', 'docs/logo.svg');
copyFileSync('assets/logo.svg', 'src/renderer/logo.svg');
