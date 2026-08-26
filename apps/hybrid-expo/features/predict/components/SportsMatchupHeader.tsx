import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import { semantic } from '@/theme';
import { teamInitials } from '@/features/predict/formatPredictTitle';

interface SportsMatchupHeaderProps {
  homeTeam: string;
  awayTeam: string;
  homeLogo?: string | null;
  awayLogo?: string | null;
  league: string | null;
  startsAt: string | null;
  active: boolean | null;
}

function formatKickoff(value: string): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

function TeamBlock({ team, logo }: { team: string; logo?: string | null }) {
  const initials = teamInitials(team);
  return (
    <View style={styles.teamBlock}>
      <View style={styles.crest}>
        {logo ? <Image source={{ uri: logo }} style={styles.logo} contentFit="contain" /> : initials ? <Text style={styles.initials}>{initials}</Text> : null}
      </View>
      <Text style={styles.teamName} numberOfLines={2}>
        {team}
      </Text>
    </View>
  );
}

export function SportsMatchupHeader({
  homeTeam,
  awayTeam,
  homeLogo,
  awayLogo,
  league,
  startsAt,
  active,
}: SportsMatchupHeaderProps) {
  const kickoff = active === false || !startsAt ? null : formatKickoff(startsAt);
  const accessibilityLabel =
    `${homeTeam} versus ${awayTeam}` + (kickoff ? `, kickoff ${kickoff}` : '');

  return (
    <View accessible={true} accessibilityLabel={accessibilityLabel} style={styles.card}>
      <TeamBlock team={homeTeam} logo={homeLogo} />
      <View style={styles.center}>
        {league ? <Text style={styles.league}>{league}</Text> : null}
        <Text style={styles.versus}>VS</Text>
        {active === false ? (
          <Text style={styles.closed}>Closed</Text>
        ) : kickoff ? (
          <Text style={styles.kickoff}>{kickoff}</Text>
        ) : null}
        <Text style={styles.moneyline}>Moneyline</Text>
      </View>
      <TeamBlock team={awayTeam} logo={awayLogo} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 22,
  },
  teamBlock: {
    flex: 1,
    alignItems: 'center',
  },
  crest: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    fontFamily: 'monospace',
    fontSize: 20,
    fontWeight: '700',
    color: semantic.text.primary,
  },
  logo: { width: 52, height: 52 },
  teamName: {
    marginTop: 10,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '600',
    color: semantic.text.primary,
    textAlign: 'center',
  },
  center: {
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  versus: { fontFamily: 'monospace', fontSize: 22, fontWeight: '900', color: semantic.text.primary },
  league: {
    fontSize: 10,
    lineHeight: 13,
    letterSpacing: 2,
    textTransform: 'uppercase',
    fontWeight: '600',
    color: semantic.text.faint,
  },
  kickoff: {
    marginTop: 6,
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 16,
    color: semantic.text.dim,
  },
  closed: {
    marginTop: 6,
    fontSize: 12,
    lineHeight: 16,
    color: semantic.text.faint,
  },
  moneyline: { paddingTop: 6, fontFamily: 'monospace', fontSize: 9, color: semantic.text.faint },
});
