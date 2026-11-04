import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';

const base = 'https://tcgcsv.com';
const headers = { 'User-Agent': 'pokemon-tcg-sales/0.1.0' };
const categories = [3, 85];

function words(value) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replaceAll('♀', ' female ').replaceAll('♂', ' male ')
    .replace(/['’]s\b/g, ' ').replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/\bnidoran\s*f\b/g, 'nidoran female').replace(/\bnidoran\s*m\b/g, 'nidoran male');
}

function display(name) {
  const special = { 'mr-mime': 'Mr. Mime', 'mime-jr': 'Mime Jr.', 'ho-oh': 'Ho-Oh',
    farfetchd: "Farfetch'd", sirfetchd: "Sirfetch'd", 'type-null': 'Type: Null',
    'porygon-z': 'Porygon-Z', 'nidoran-f': 'Nidoran (female)', 'nidoran-m': 'Nidoran (male)' };
  return special[name] ?? name.split('-').map(part => part[0].toUpperCase() + part.slice(1)).join(' ');
}

function speciesMatcher(species) {
  const patterns = [...species].sort().map(name => ({ pattern: ` ${words(name)} `, name: display(name) }));
  return (name, attributes) => {
    const hp = attributes.find(item => item.name === 'HP')?.value;
    const type = attributes.find(item => item.name === 'Card Type')?.value ?? '';
    if (!/^\d+$/.test(String(hp)) || Number(hp) <= 0 ||
        /\b(?:trainer|energy|supporter|stadium|item|tool)\b/i.test(type)) return [];
    const text = ` ${words(name)} `;
    return patterns.filter(item => text.includes(item.pattern)).map(item => item.name);
  };
}

export function speciesForProduct(name, attributes, species) {
  return speciesMatcher(species)(name, attributes);
}

export function remapCatalogSpecies(store) {
  const species = store.db.prepare('SELECT name FROM pokemon_species').all().map(row => row.name);
  if (!species.length) return 0;
  const match = speciesMatcher(species);
  const update = store.db.prepare('UPDATE catalog_products SET pokemon=? WHERE product_id=?');
  let changed = 0;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const rows = store.db.prepare('SELECT product_id,name,hp,card_type,pokemon FROM catalog_products').all();
    for (const row of rows) {
      const pokemon = JSON.stringify(match(row.name, [
        { name: 'HP', value: row.hp }, { name: 'Card Type', value: row.card_type },
      ]));
      if (pokemon !== row.pokemon) { update.run(pokemon, row.product_id); changed++; }
    }
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return changed;
}

async function response(fetcher, url) {
  const result = await fetcher(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!result.ok) throw new Error(`Catalog request failed: HTTP ${result.status} (${url}).`);
  return result;
}

async function collection(fetcher, url) {
  const data = await (await response(fetcher, url)).json();
  const emptyWithoutCount = Array.isArray(data.results) && data.results.length === 0 &&
    data.totalItems === undefined;
  if (data.success !== true || !Array.isArray(data.results) ||
      (!emptyWithoutCount && (!Number.isSafeInteger(data.totalItems) || data.totalItems !== data.results.length)) ||
      (data.errors?.length ?? 0) > 0) throw new Error(`Incomplete catalog response: ${url}.`);
  return data.results;
}

async function sourceBuild(fetcher) {
  const value = (await (await response(fetcher, `${base}/last-updated.txt`)).text()).trim();
  if (!value || value.length > 200) throw new Error('Invalid catalog build marker.');
  return value;
}

export async function syncCatalog(store, {
  fetcher = fetch, pause = () => sleep(100), log = console.log,
} = {}) {
  const build = await sourceBuild(fetcher);
  const completed = store.db.prepare(
    "SELECT id FROM catalog_runs WHERE source_build=? AND status='complete' LIMIT 1"
  ).get(build);
  if (completed) return { skipped: true, species_remapped: remapCatalogSpecies(store), ...store.catalogSummary() };
  const started = new Date().toISOString();
  const run = Number(store.db.prepare(`INSERT INTO catalog_runs
    (source_build,started_at,status) VALUES (?,?,'running')`).run(build, started).lastInsertRowid);
  try {
    let species = store.db.prepare('SELECT name FROM pokemon_species ORDER BY name').all()
      .map(row => row.name);
    const speciesFetched = store.db.prepare('SELECT min(fetched_at) AS date FROM pokemon_species').get().date;
    if (!species.length || Date.parse(started) - Date.parse(speciesFetched) >= 86400000) {
      await pause();
      const data = await (await response(fetcher,
        'https://pokeapi.co/api/v2/pokemon-species?limit=2000')).json();
      if (!Array.isArray(data.results) || !data.results.length || data.next || data.count !== data.results.length ||
          !data.results.every(row => typeof row.name === 'string' && /^[a-z0-9-]+$/.test(row.name))) {
        throw new Error('Incomplete Pokemon species list.');
      }
      species = data.results.map(row => row.name);
      const insert = store.db.prepare('INSERT INTO pokemon_species VALUES (?,?)');
      store.db.exec('BEGIN IMMEDIATE');
      try {
        store.db.exec('DELETE FROM pokemon_species');
        for (const name of species) insert.run(name, started);
        store.db.exec('COMMIT');
      } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    }
    const matchSpecies = speciesMatcher(species);
    const groups = [];
    for (const category of categories) {
      await pause();
      const rows = await collection(fetcher, `${base}/tcgplayer/${category}/groups`);
      for (const group of rows) {
        if (!Number.isSafeInteger(group.groupId) || group.groupId < 1 ||
            group.categoryId !== category || typeof group.name !== 'string') {
          throw new Error('Invalid catalog group.');
        }
        groups.push({ ...group, category });
      }
    }
    if (new Set(groups.map(group => group.groupId)).size !== groups.length) {
      throw new Error('Duplicate catalog groups.');
    }
    store.db.prepare('UPDATE catalog_runs SET groups_expected=? WHERE id=?').run(groups.length, run);
    const cached = store.db.prepare(
      'SELECT product_count FROM catalog_downloads WHERE source_build=? AND category_id=? AND group_id=?'
    );
    const insert = store.db.prepare(`INSERT INTO catalog_products
      (product_id,category_id,group_id,set_name,name,number,rarity,card_type,hp,pokemon,
        source_modified,source_build,is_current) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT(product_id) DO UPDATE SET category_id=excluded.category_id,
        group_id=excluded.group_id,set_name=excluded.set_name,name=excluded.name,
        number=excluded.number,rarity=excluded.rarity,card_type=excluded.card_type,
        hp=excluded.hp,pokemon=excluded.pokemon,source_modified=excluded.source_modified,
        source_build=excluded.source_build,is_current=1`);
    for (const [index, group] of groups.entries()) {
      if (!cached.get(build, group.category, group.groupId)) {
        await pause();
        const products = await collection(fetcher,
          `${base}/tcgplayer/${group.category}/${group.groupId}/products`);
        const seen = new Set();
        store.db.exec('BEGIN IMMEDIATE');
        try {
          for (const product of products) {
            const attributes = product.extendedData === undefined ? [] : product.extendedData;
            if (!Number.isSafeInteger(product.productId) || product.productId < 1 ||
                product.categoryId !== group.category || product.groupId !== group.groupId ||
                typeof product.name !== 'string' || !product.name.trim() ||
                seen.has(product.productId) || !Array.isArray(attributes)) {
              throw new Error(`Invalid product in group ${group.groupId}.`);
            }
            seen.add(product.productId);
            const attr = key => String(attributes.find(item => item.name === key)?.value ?? '');
            insert.run(product.productId, group.category, group.groupId, group.name, product.name,
              attr('Number'), attr('Rarity'), attr('Card Type'), attr('HP'),
              JSON.stringify(matchSpecies(product.name, attributes)),
              String(product.modifiedOn ?? ''), build);
          }
          store.db.prepare('INSERT INTO catalog_downloads VALUES (?,?,?,?)')
            .run(build, group.category, group.groupId, products.length);
          store.db.exec('COMMIT');
        } catch (error) { store.db.exec('ROLLBACK'); throw error; }
      }
      store.db.prepare('UPDATE catalog_runs SET groups_downloaded=? WHERE id=?').run(index + 1, run);
      if ((index + 1) % 25 === 0 || index + 1 === groups.length) {
        log(`Catalog sets: ${index + 1}/${groups.length}`);
      }
    }
    for (const group of groups) {
      const expected = cached.get(build, group.category, group.groupId).product_count;
      const actual = store.db.prepare(`SELECT count(*) AS n FROM catalog_products
        WHERE source_build=? AND category_id=? AND group_id=?`)
        .get(build, group.category, group.groupId).n;
      if (actual !== expected) {
        store.db.prepare(`DELETE FROM catalog_downloads
          WHERE source_build=? AND category_id=? AND group_id=?`)
          .run(build, group.category, group.groupId);
        throw new Error(`Persisted product count does not match group ${group.groupId}; rerun to repair.`);
      }
    }
    await pause();
    if (await sourceBuild(fetcher) !== build) {
      throw new Error('Source build changed during sync; rerun to avoid mixed snapshots.');
    }
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.db.prepare('UPDATE catalog_products SET is_current=0 WHERE source_build<>?').run(build);
      store.db.prepare(`UPDATE catalog_runs SET status='complete',finished_at=? WHERE id=?`)
        .run(new Date().toISOString(), run);
      store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    return { skipped: false, ...store.catalogSummary() };
  } catch (error) {
    store.db.prepare(`UPDATE catalog_runs SET status='failed',finished_at=?,warning=? WHERE id=?`)
      .run(new Date().toISOString(), error.message, run);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = new Store(resolve(process.env.DATA_DIR ?? 'data', 'sales.sqlite'));
  try { console.log(JSON.stringify(await syncCatalog(store), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { store.close(); }
}
