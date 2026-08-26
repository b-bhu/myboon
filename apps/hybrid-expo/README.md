# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Predict E2E

Run the wallet-free Predict lifecycle suite:

```bash
pnpm --filter hybrid-expo e2e:predict
```

The suite drives the real Expo web UI with Playwright and intercepts Predict API calls with a deterministic sports-market model. By default it uses fake wallet addresses. To point the UI at a local test wallet identity, create `.predict-e2e.local` in the repo root:

```bash
PREDICT_E2E_POLYMARKET_PRIVATE_KEY=
```

The key can be a Solana base58 secret key, a JSON byte array, or comma-separated bytes. Playwright derives the Solana address and the Polygon EOA from this key by signing `myboon:polymarket:enable`, then passes only public addresses to the app. `PREDICT_E2E_POLYMARKET_PRIVATE_KEY` stays in the Playwright Node process.

For the mocked UI suite, the deposit-wallet address falls back to the derived Polygon EOA. To mirror an already-created Polymarket deposit wallet exactly, add:

```bash
PREDICT_E2E_DEPOSIT_WALLET_ADDRESS=
```

The Deposit Wallet address comes from the mobile unified SDK's authenticated `SecureClient.account`; the API does not derive or store it.

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
