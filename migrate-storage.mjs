import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  'https://jtyecjkdytklduivybah.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp0eWVjamtkeXRrbGR1aXZ5YmFoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3MzQ1MjgsImV4cCI6MjA5NjMxMDUyOH0.DPMjU17YvBF0E1DDtKopzPkkRnQc63MQ4wYpaM013D0'
);

// list all root-level files (not in logos/ or files/)
const { data: rootFiles } = await sb.storage.from('delivr').list('', { limit: 100 });

const toDelete = [];
for (const f of rootFiles || []) {
  if (f.name === 'logos' || f.name === 'files') continue; // skip folders
  console.log(`Moving ${f.name} → files/${f.name}`);
  const { data: fileData } = await sb.storage.from('delivr').download(f.name);
  if (fileData) {
    await sb.storage.from('delivr').upload(`files/${f.name}`, fileData, { upsert: true });
    toDelete.push(f.name);
  }
}

if (toDelete.length) {
  await sb.storage.from('delivr').remove(toDelete);
  console.log(`✓ Moved ${toDelete.length} files, cleaned up root`);
} else {
  console.log('Nothing to migrate');
}
