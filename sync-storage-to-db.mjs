import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  'https://jtyecjkdytklduivybah.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp0eWVjamtkeXRrbGR1aXZ5YmFoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3MzQ1MjgsImV4cCI6MjA5NjMxMDUyOH0.DPMjU17YvBF0E1DDtKopzPkkRnQc63MQ4wYpaM013D0'
);

// skip these internal files
const SKIP = new Set(['clients.json', 'manifest.json']);

const { data: storageFiles } = await sb.storage.from('delivr').list('files', { limit: 200 });
const { data: dbFiles } = await sb.from('files').select('name');
const dbNames = new Set((dbFiles || []).map(f => f.name));

const toInsert = (storageFiles || [])
  .filter(f => f.name && !SKIP.has(f.name) && !dbNames.has(f.name))
  .map(f => ({ name: f.name, size_bytes: f.metadata?.size || 0 }));

if (!toInsert.length) { console.log('All files already in DB'); process.exit(0); }

const { error } = await sb.from('files').insert(toInsert);
if (error) console.error('❌', error.message);
else console.log(`✓ Synced ${toInsert.length} files into database:`, toInsert.map(f => f.name));
