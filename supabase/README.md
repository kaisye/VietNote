# VietNote credit server (Supabase)

Users sign in with an email code. Credit is counted in seconds of Soniox
streaming. The app never sees the long-lived Soniox key: for each stream it
calls the `soniox-key` Edge Function, which does the following:

1. Reserves up to 30 minutes of the user's balance.
2. Mints a Soniox temporary key for that reservation:
   - `single_use`
   - valid for 60 s
   - `max_session_duration_seconds` equal to the reservation
   - `client_reference_id` set to the grant id
3. When the stream ends, the app releases the grant, and the server refunds the
   unused time by its own clock.
4. `soniox-reconcile` later settles every grant against Soniox usage logs, which
   are the source of truth. If a client released a key early while it was still
   streaming, reconciliation charges the difference. The balance can go
   negative, and a negative balance blocks new keys.

## Setup

1. **Create a Supabase project**, then run:
   ```sh
   supabase link --project-ref <ref>
   supabase db push
   ```
2. **Set up secrets and deploy the functions.**
   1. In the Soniox console, give the Soniox key the **Temporary API keys** and Speech-to-Text permissions.
   2. Run `./scripts/supabase-secrets.sh`. It reads the key from the Keychain, then sets `SONIOX_API_KEY` and a fresh `CRON_SECRET` as function secrets and mirrors `CRON_SECRET` into Vault.
   3. Deploy the functions:
      ```sh
      supabase functions deploy soniox-key --use-api
      supabase functions deploy soniox-reconcile --use-api
      ```
3. **Enable email codes.** Go to Authentication → Email Templates → *Magic Link*. Include `{{ .Token }}` in the template so the email contains the 6-digit code. The app has no redirect URL to receive a link.
4. **Schedule reconciliation.** In the SQL editor, enable `pg_cron` and `pg_net`, then run the SQL below. The job reads the secret from Vault, so the job definition holds no secret.
   ```sql
   select cron.schedule('soniox-reconcile', '*/15 * * * *', $$
     select net.http_post(
       url := 'https://<ref>.supabase.co/functions/v1/soniox-reconcile',
       headers := jsonb_build_object('x-cron-secret',
         (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')));
   $$);
   ```
5. **Point the app at the project.** The project URL and anon key are defaults in `src-tauri/src/account.rs`. Both are public by design. Set `VIETNOTE_SUPABASE_URL` and `VIETNOTE_SUPABASE_ANON_KEY` to override them.

## Operations

- **New accounts:** each gets 60 free minutes (`handle_new_user`).
- **Top-up:** payment webhooks, or you by hand, call `select add_credit('<user uuid>', 36000, 'purchase', 'order 123');`.
- **Audit:** every balance change is a row in `credit_ledger`.
- **Bring-your-own key:** users who save their own Soniox key in Settings bypass credit entirely.

## Thanh toán payOS

- `credit_packages`: bảng giá và khuyến mãi, sửa trong Table Editor (xem chú thích từng cột).
- `credit_offers()`: giá đang bán sau khuyến mãi, gọi công khai được (website, app).
- `credit_orders`, `pay_credit_order()`: đơn hàng; mỗi đơn chỉ cộng giờ một lần.
- Edge Function `payos` (app gọi): `offers`, `create` (tạo link thanh toán), `status` (hỏi thẳng payOS nếu webhook chưa về).
- Edge Function `payos-webhook`: payOS báo đã nhận tiền, xác thực bằng chữ ký checksum key.

Cài đặt một lần (lấy 3 khóa ở my.payos.vn → Kênh thanh toán):

```sh
npx supabase secrets set --project-ref pyknksfyqlsfqodcsawm \
  PAYOS_CLIENT_ID=... PAYOS_API_KEY=... PAYOS_CHECKSUM_KEY=... SITE_URL=https://vietnote.pages.dev
```

Rồi đặt Webhook URL của kênh thanh toán trên my.payos.vn thành
`https://pyknksfyqlsfqodcsawm.supabase.co/functions/v1/payos-webhook`.
