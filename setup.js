import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function createTable() {
  const { error } = await supabase.rpc('execute_sql', {
    sql: `
      create table if not exists reviews (
        id bigint generated always as identity primary key,
        url text not null,
        review text not null,
        screenshot_base64 text,
        scores jsonb,
        created_at timestamp with time zone default timezone('utc'::text, now())
      );
    `
  });

  if (error) {
    console.error('❌ Failed to create table:', error.message);
  } else {
    console.log('✅ Supabase table "reviews" created (or already exists).');
  }
}

createTable();