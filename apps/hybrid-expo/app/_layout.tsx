import React from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { PrivyProvider } from '@/providers/PrivyProvider';
import { WalletProvider } from '@/providers/WalletProvider';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { WalletSheetProvider } from '@/features/wallet/WalletSheetProvider';
import { warmTokenIdentityCatalog } from '@/lib/token-identity';
import 'react-native-reanimated';

export default function RootLayout() {
  // Pull the whole token catalog once, up front. The app opens on the feed and
  // markets are below the fold, so this is done well before a market row needs
  // an icon — and it replaces the per-screen resolves that round-tripped for
  // tokens two venues share. Fire-and-forget by design: it never throws, and
  // until it lands rows render the venue icon or the letter box as usual.
  React.useEffect(() => {
    void warmTokenIdentityCatalog();
  }, []);

  return (
    <PrivyProvider>
    <WalletProvider>
    <WalletSheetProvider>
      <View style={{ flex: 1 }}>
        <ErrorBoundary>
          <Stack>
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="feed" options={{ headerShown: false }} />
            <Stack.Screen
              name="swap"
              options={{
                headerShown: false,
                presentation: 'transparentModal',
                animation: 'slide_from_bottom',
                contentStyle: { backgroundColor: 'transparent' },
              }}
            />
            <Stack.Screen name="spot" options={{ headerShown: false }} />
            <Stack.Screen name="markets/polymarket" options={{ headerShown: false }} />
            <Stack.Screen name="markets/polymarket/profile" options={{ headerShown: false }} />
            <Stack.Screen name="markets/polymarket/market/[slug]" options={{ headerShown: false }} />
            <Stack.Screen name="markets/polymarket/sport/[sport]/[slug]" options={{ headerShown: false }} />
            <Stack.Screen name="markets/polymarket/position/[conditionId]" options={{ headerShown: false }} />
            <Stack.Screen name="markets/pacifica" options={{ headerShown: false }} />
            <Stack.Screen name="markets/pacifica/profile" options={{ headerShown: false }} />
            <Stack.Screen name="markets/pacifica/[symbol]" options={{ headerShown: false }} />
            <Stack.Screen name="markets/phoenix" options={{ headerShown: false }} />
            <Stack.Screen name="markets/phoenix/profile" options={{ headerShown: false }} />
            <Stack.Screen name="markets/phoenix/[symbol]" options={{ headerShown: false }} />
            <Stack.Screen name="markets/meteora" options={{ headerShown: false }} />
            <Stack.Screen name="markets/meteora/profile" options={{ headerShown: false }} />
            <Stack.Screen name="markets/meteora/[poolAddress]" options={{ headerShown: false }} />
          </Stack>
        </ErrorBoundary>
      </View>
      <StatusBar style="light" />
    </WalletSheetProvider>
    </WalletProvider>
    </PrivyProvider>
  );
}
