import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { semantic, tokens } from '@/theme';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  // The screen shows the error state above; componentDidCatch is where the
  // thrown error is logged so a crash in the wild leaves a trace (#947).
  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ErrorBoundary] Unexpected error:', error, info.componentStack);
  }

  handleRetry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.message}>
            The app ran into an unexpected error. Tap below to try again.
          </Text>
          <Pressable onPress={this.handleRetry} style={styles.button}>
            <Text style={styles.buttonText}>Try Again</Text>
          </Pressable>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: semantic.background.screen,
    alignItems: 'center',
    justifyContent: 'center',
    padding: tokens.spacing.xl,
    gap: tokens.spacing.md,
  },
  title: {
    color: semantic.text.primary,
    fontSize: tokens.fontSize.lg,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  message: {
    color: semantic.text.dim,
    fontSize: tokens.fontSize.md,
    textAlign: 'center',
    lineHeight: 22,
  },
  button: {
    marginTop: tokens.spacing.sm,
    backgroundColor: semantic.text.accent,
    paddingHorizontal: tokens.spacing.lg,
    paddingVertical: tokens.spacing.sm,
    borderRadius: tokens.radius.xs,
  },
  buttonText: {
    color: semantic.background.screen,
    fontSize: tokens.fontSize.sm,
    fontFamily: 'monospace',
    fontWeight: '700',
    textTransform: 'uppercase',
  },
});
