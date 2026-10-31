import { resolve } from 'node:path';
import { Store } from './store.js';
import { collectAll, productDetails } from './collector.js';

const store = new Store(resolve(process.env.DATA_DIR ?? 'data', 'sales.sqlite'));
try {
  if (process.argv.includes('--seed')) {
    for (const [id, pokemon] of [[42382, ['Charizard']], [246708, ['Trevenant']], [502001, []]]) {
      if (store.products().some(p => p.id === id)) continue;
      const product = await productDetails(`https://www.tcgplayer.com/product/${id}`);
      store.addProduct({ ...product, pokemon });
      console.log(`Added starter product: ${product.name} (${product.kind})`);
    }
  } else {
    if (process.env.ENABLE_BROWSER_SAMPLING !== '1') {
      throw new Error('Page-based sampling is disabled. Use npm run catalog for bulk metadata. Complete sales require a verified bulk feed; ENABLE_BROWSER_SAMPLING=1 is diagnostic only.');
    }
    const results = await collectAll(store);
    console.log(JSON.stringify(results, null, 2));
    if (!results.length) console.log('No products tracked. Add Pokemon product URLs in the dashboard first.');
    if (results.some(r => r.status === 'failed')) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  store.close();
}
