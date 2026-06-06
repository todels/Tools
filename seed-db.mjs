import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  'https://jtyecjkdytklduivybah.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp0eWVjamtkeXRrbGR1aXZ5YmFoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3MzQ1MjgsImV4cCI6MjA5NjMxMDUyOH0.DPMjU17YvBF0E1DDtKopzPkkRnQc63MQ4wYpaM013D0'
);

const BASE = 'https://jtyecjkdytklduivybah.supabase.co/storage/v1/object/public/delivr/logos/';

const clients = [
  { name: 'Altura',     logo: BASE + 'Altura.png' },
  { name: 'BAYC',       logo: BASE + 'BAYC.png' },
  { name: 'Bruce Lee',  logo: BASE + 'Bruce%20Lee.png' },
  { name: 'Chain',      logo: BASE + 'Chain.png' },
  { name: 'Degen',      logo: BASE + 'Degen.png' },
  { name: 'Dreamworks', logo: BASE + 'Dreamworks.png' },
  { name: 'Sandbox',    logo: BASE + 'Sandbox.png' },
  { name: 'Sixr',       logo: BASE + 'Sixr.png' },
  { name: 'Sport.fun',  logo: BASE + 'Sport.fun.png' },
  { name: 'Thrust',     logo: BASE + 'Thrust.png' },
  { name: 'WSJ',        logo: BASE + 'WSJ.png' },
  { name: 'Whop',       logo: BASE + 'Whop.png' },
  { name: 'Zama',       logo: BASE + 'Zama.png' },
];

const { error } = await sb.from('clients').upsert(
  clients.map(c => ({ ...c, color: '#5B9CF6' })),
  { onConflict: 'name' }
);

if (error) console.error('❌', error.message);
else console.log('✓ seeded', clients.length, 'clients into database');
