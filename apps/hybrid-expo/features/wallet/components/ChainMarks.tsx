/**
 * ChainMarks — the Receive "Works on" chain icons (issue #939, wallet.html
 * at 02b98eba, `recvMid` + `.chainrow2`/`.mk.c`): each chain at 24px as a
 * round `.mk` — card background, hairline edge — whose mark fills the
 * circle. Solana and the three big EVM marks are inline SVG strings; the
 * four chains the mock ships as bitmaps are bundled PNGs. Both sets are
 * extracted once from the mock's `window.LOGOS`; the SVG preambles
 * (`<?xml`, `<!DOCTYPE`) are dropped and Base's `<style>` fill is inlined
 * as an attribute, because `SvgXml` ignores `<style>`.
 */

import type { ImageSourcePropType } from 'react-native';
import { Image, StyleSheet, View } from 'react-native';
import { SvgXml } from 'react-native-svg';

import { tokens } from '@/theme';

export type ChainMarkName =
  | 'solana'
  | 'base'
  | 'ethereum'
  | 'arbitrum'
  | 'polygon'
  | 'optimism'
  | 'bnb';

export const SOLANA_MARK_SVG = `
<svg width="101" height="88" viewBox="0 0 101 88" fill="none" xmlns="http://www.w3.org/2000/svg">
<path d="M100.48 69.3817L83.8068 86.8015C83.4444 87.1799 83.0058 87.4816 82.5185 87.6878C82.0312 87.894 81.5055 88.0003 80.9743 88H1.93563C1.55849 88 1.18957 87.8926 0.874202 87.6912C0.558829 87.4897 0.31074 87.2029 0.160416 86.8659C0.0100923 86.529 -0.0359181 86.1566 0.0280382 85.7945C0.0919944 85.4324 0.263131 85.0964 0.520422 84.8278L17.2061 67.408C17.5676 67.0306 18.0047 66.7295 18.4904 66.5234C18.9762 66.3172 19.5002 66.2104 20.0301 66.2095H99.0644C99.4415 66.2095 99.8104 66.3169 100.126 66.5183C100.441 66.7198 100.689 67.0067 100.84 67.3436C100.99 67.6806 101.036 68.0529 100.972 68.415C100.908 68.7771 100.737 69.1131 100.48 69.3817ZM83.8068 34.3032C83.4444 33.9248 83.0058 33.6231 82.5185 33.4169C82.0312 33.2108 81.5055 33.1045 80.9743 33.1048H1.93563C1.55849 33.1048 1.18957 33.2121 0.874202 33.4136C0.558829 33.6151 0.31074 33.9019 0.160416 34.2388C0.0100923 34.5758 -0.0359181 34.9482 0.0280382 35.3103C0.0919944 35.6723 0.263131 36.0083 0.520422 36.277L17.2061 53.6968C17.5676 54.0742 18.0047 54.3752 18.4904 54.5814C18.9762 54.7875 19.5002 54.8944 20.0301 54.8952H99.0644C99.4415 54.8952 99.8104 54.7879 100.126 54.5864C100.441 54.3849 100.689 54.0981 100.84 53.7612C100.99 53.4242 101.036 53.0518 100.972 52.6897C100.908 52.3277 100.737 51.9917 100.48 51.723L83.8068 34.3032ZM1.93563 21.7905H80.9743C81.5055 21.7907 82.0312 21.6845 82.5185 21.4783C83.0058 21.2721 83.4444 20.9704 83.8068 20.592L100.48 3.17219C100.737 2.90357 100.908 2.56758 100.972 2.2055C101.036 1.84342 100.99 1.47103 100.84 1.13408C100.689 0.79713 100.441 0.510296 100.126 0.308823C99.8104 0.107349 99.4415 1.24074e-05 99.0644 0L20.0301 0C19.5002 0.000878397 18.9762 0.107699 18.4904 0.313848C18.0047 0.519998 17.5676 0.821087 17.2061 1.19848L0.524723 18.6183C0.267681 18.8866 0.0966198 19.2223 0.0325185 19.5839C-0.0315829 19.9456 0.0140624 20.3177 0.163856 20.6545C0.31365 20.9913 0.561081 21.2781 0.875804 21.4799C1.19053 21.6817 1.55886 21.7896 1.93563 21.7905Z" fill="url(#paint0_linear_174_4403)"/>
<defs>
<linearGradient id="paint0_linear_174_4403" x1="8.52558" y1="90.0973" x2="88.9933" y2="-3.01622" gradientUnits="userSpaceOnUse">
<stop offset="0.08" stop-color="#9945FF"/>
<stop offset="0.3" stop-color="#8752F3"/>
<stop offset="0.5" stop-color="#5497D5"/>
<stop offset="0.6" stop-color="#43B4CA"/>
<stop offset="0.72" stop-color="#28E0B9"/>
<stop offset="0.97" stop-color="#19FB9B"/>
</linearGradient>
</defs>
</svg>
`;

export const BASE_MARK_SVG = `
<svg id="Layer_1" data-name="Layer 1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 1280">
  <path fill="blue" d="M0,101.12c0-34.64,0-51.95,6.53-65.28,6.25-12.76,16.56-23.07,29.32-29.32C49.17,0,66.48,0,101.12,0h1077.76c34.63,0,51.96,0,65.28,6.53,12.75,6.25,23.06,16.56,29.32,29.32,6.52,13.32,6.52,30.64,6.52,65.28v1077.76c0,34.63,0,51.96-6.52,65.28-6.26,12.75-16.57,23.06-29.32,29.32-13.32,6.52-30.65,6.52-65.28,6.52H101.12c-34.64,0-51.95,0-65.28-6.52-12.76-6.26-23.07-16.57-29.32-29.32-6.53-13.32-6.53-30.65-6.53-65.28V101.12Z"/>
</svg>
`;

export const ETHEREUM_MARK_SVG = `
<svg width="100%" height="100%" viewBox="0 0 142 215" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xml:space="preserve" xmlns:serif="http://www.serif.com/" style="fill-rule:evenodd;clip-rule:evenodd;stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:7;">
    <g transform="matrix(1,0,0,1,-1259.52,-529.088)">
        <g id="Ethereum">
            <g id="Bottom">
                <g id="Purple2" transform="matrix(1.08181,0,0,-1.03277,-108.829,1366.48)">
                    <path d="M1394.74,693.463L1330.36,604.024L1330.36,654.238L1394.74,693.463Z" style="fill:rgb(200,178,245);stroke:rgb(52,65,192);stroke-width:2.27px;"/>
                </g>
                <g id="Yellow2" transform="matrix(-1.08181,0,0,-1.03277,2769.57,1366.48)">
                    <path d="M1394.74,693.463L1330.36,604.024L1330.36,654.238L1394.74,693.463Z" style="fill:rgb(238,203,192);stroke:rgb(52,65,192);stroke-width:2.27px;"/>
                </g>
            </g>
            <g id="Top">
                <g id="Blue1" transform="matrix(-1,0,0,1,2659.32,-0.0263692)">
                    <path d="M1398.61,639.614L1328.95,608.641L1328.95,679.249L1398.61,639.614Z" style="fill:rgb(135,169,240);stroke:rgb(52,65,192);stroke-width:2.4px;"/>
                </g>
                <g id="Purple1" transform="matrix(1,0,0,1,1.41643,-0.0263692)">
                    <path d="M1398.61,639.614L1328.95,608.641L1328.95,679.249L1398.61,639.614Z" style="fill:rgb(202,179,245);stroke:rgb(52,65,192);stroke-width:2.4px;"/>
                </g>
                <g id="Yellow1" transform="matrix(-1.08181,0,0,1.03277,2769.57,-93.5314)">
                    <path d="M1394.74,709.855L1330.36,604.024L1330.36,679.865L1394.74,709.855Z" style="fill:rgb(238,203,192);stroke:rgb(52,65,192);stroke-width:2.27px;"/>
                </g>
                <g id="Green1" transform="matrix(1.08181,0,0,1.03277,-108.829,-93.5314)">
                    <path d="M1394.74,709.855L1330.36,604.024L1330.36,679.865L1394.74,709.855Z" style="fill:rgb(184,251,246);stroke:rgb(52,65,192);stroke-width:2.27px;"/>
                </g>
            </g>
        </g>
    </g>
</svg>
`;

const CHAIN_SOURCES: Record<ChainMarkName, { xml: string } | { png: ImageSourcePropType }> = {
  solana: { xml: SOLANA_MARK_SVG },
  base: { xml: BASE_MARK_SVG },
  ethereum: { xml: ETHEREUM_MARK_SVG },
  arbitrum: { png: require('../../../assets/chains/arbitrum.png') },
  polygon: { png: require('../../../assets/chains/polygon.png') },
  optimism: { png: require('../../../assets/chains/optimism.png') },
  bnb: { png: require('../../../assets/chains/bnb.png') },
};

/** One mock `.mk.c` circle: `size` wide, mark inset by the 1px hairline. */
export function ChainMark({ chain, size }: { chain: ChainMarkName; size: number }) {
  const source = CHAIN_SOURCES[chain];
  if ('xml' in source) {
    return (
      <View style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }]}>
        <SvgXml xml={source.xml} width={size - 2} height={size - 2} />
      </View>
    );
  }
  return (
    <View style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }]}>
      <Image
        source={source.png}
        style={{ width: size - 2, height: size - 2, borderRadius: (size - 2) / 2 }}
        resizeMode="contain"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Mock `.mk`: card fill plus an inset 1px `.mk.c` hairline edge.
  circle: {
    borderWidth: 1,
    borderColor: tokens.colors.borderMuted,
    backgroundColor: tokens.colors.ground,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
