import { StyleSheet, Text, View } from 'react-native';
import { semantic, tokens } from '@/theme';
import { teamInitials } from '@/features/predict/formatPredictTitle';

interface SportsMatchupHeaderProps {
  homeTeam: string;
  awayTeam: string;
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

function TeamBlock({ team }: { team: string }) {
  const initials = teamInitials(team);
  return (
    <View style={styles.teamBlock}>
      <View style={styles.crest}>
        {initials ? <Text style={styles.initials}>{initials}</Text> : null}
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
  league,
  startsAt,
  active,
}: SportsMatchupHeaderProps) {
  const kickoff = active === false || !startsAt ? null : formatKickoff(startsAt);
  const accessibilityLabel =
    `${awayTeam} versus ${homeTeam}` + (kickoff ? `, kickoff ${kickoff}` : '');

  return (
    <View accessible={true} accessibilityLabel={accessibilityLabel} style={styles.card}>
      <TeamBlock team={awayTeam} />
      <View style={styles.center}>
        {league ? <Text style={styles.league}>{league}</Text> : null}
        {active === false ? (
          <Text style={styles.closed}>Closed</Text>
        ) : kickoff ? (
          <Text style={styles.kickoff}>{kickoff}</Text>
        ) : null}
      </View>
      <TeamBlock team={homeTeam} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: tokens.colors.surface,
    borderColor: semantic.border.muted,
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
  },
  teamBlock: {
    flex: 1,
    alignItems: 'center',
  },
  crest: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: tokens.colors.lift,
    borderWidth: 1,
    borderColor: semantic.border.muted,
  },
  initials: {
    fontFamily: 'monospace',
    fontSize: 20,
    fontWeight: '700',
    color: semantic.text.primary,
  },
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
});
