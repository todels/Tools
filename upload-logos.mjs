import { createClient } from '@supabase/supabase-js';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const sb = createClient(
  'https://jtyecjkdytklduivybah.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp0eWVjamtkeXRrbGR1aXZ5YmFoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3MzQ1MjgsImV4cCI6MjA5NjMxMDUyOH0.DPMjU17YvBF0E1DDtKopzPkkRnQc63MQ4wYpaM013D0'
);

const dir = './Client logos';
const files = readdirSync(dir);

for (const file of files) {
  const buf = readFileSync(join(dir, file));
  const { error } = await sb.storage.from('delivr').upload(`logos/${file}`, buf, {
    contentType: 'image/png',
    upsert: true
  });
  if (error) console.error(`❌ ${file}:`, error.message);
  else console.log(`✓ ${file}`);
}

console.log('Done');
