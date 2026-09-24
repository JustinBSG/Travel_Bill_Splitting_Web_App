-- LOCAL DEVELOPMENT ONLY (runs on `supabase db reset`, never on `db push`).
-- Sample mid-market rates for today's Hong Kong date so save_expense can lock
-- a rate without an FX API key. Not real data: source = 'seed-sample'.
select public.upsert_fx_rates(
  (now() at time zone 'Asia/Hong_Kong')::date,
  'USD',
  '{
    "USD": "1", "HKD": "7.78", "JPY": "149.5", "KRW": "1350", "TWD": "32.1",
    "CNY": "7.12", "MOP": "8.02", "EUR": "0.905", "GBP": "0.768", "SGD": "1.31",
    "THB": "35.4", "VND": "25400", "MYR": "4.42", "AUD": "1.49", "PHP": "56.2",
    "IDR": "15600", "NZD": "1.63", "CAD": "1.36", "CHF": "0.86", "INR": "83.4"
  }'::jsonb,
  'seed-sample'
);
