import React from 'react';
import { View } from 'react-native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { PrivyProvider } from '@/providers/PrivyProvider';
import { WalletProvider } from '@/providers/WalletProvider';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { WalletSheetProvider } from '@/features/wallet/WalletSheetProvider';
import 'react-native-reanimated';

export default function RootLayout() {
  return (
    <PrivyProvider>
    <WalletProvider>
    <WalletSheetProvider>
      <View style={{ flex: 1 }}>
        <ErrorBoundary>
          <Stack>
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="feed" options={{ headerShown: false }} />
            <Stack.Screen name="swap" options={{ headerShown: false }} />
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
