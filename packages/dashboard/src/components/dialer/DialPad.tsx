'use client';

import React from 'react';
import { useGateway } from '../../lib/context/GatewayContext';

interface DialPadProps {
  onKeyPress: (char: string) => void;
  disabled?: boolean;
}

const KEYS = [
  { char: '1', letters: '' },
  { char: '2', letters: 'ABC' },
  { char: '3', letters: 'DEF' },
  { char: '4', letters: 'GHI' },
  { char: '5', letters: 'JKL' },
  { char: '6', letters: 'MNO' },
  { char: '7', letters: 'PQRS' },
  { char: '8', letters: 'TUV' },
  { char: '9', letters: 'WXYZ' },
  { char: '*', letters: '' },
  { char: '0', letters: '+' },
  { char: '#', letters: '' },
];

export function DialPad({ onKeyPress, disabled }: DialPadProps) {
  const { activeCall, sendDtmf } = useGateway();

  const isCallActive = activeCall?.state === 'ACTIVE';

  const handleClick = async (char: string) => {
    if (disabled) return;

    if (isCallActive) {
      // In active call: sends DTMF digit directly
      try {
        await sendDtmf({ digit: char as any, durationMs: 200 });
      } catch (err) {
        console.error('DTMF send failed:', err);
      }
    } else {
      // Appends to phone number input
      onKeyPress(char);
    }
  };

  return (
    <div className="grid grid-cols-3 gap-2.5 max-w-xs mx-auto">
      {KEYS.map(({ char, letters }) => (
        <button
          key={char}
          type="button"
          onClick={() => handleClick(char)}
          disabled={disabled}
          className="h-14 rounded-xl bg-slate-900/80 hover:bg-slate-800 border border-slate-800 text-slate-100 flex flex-col items-center justify-center transition active:scale-95 disabled:opacity-50 select-none shadow-sm hover:border-slate-700"
        >
          <span className="text-xl font-bold font-mono leading-none">{char}</span>
          {letters ? (
            <span className="text-[9px] font-mono tracking-widest text-slate-500 mt-1 uppercase">
              {letters}
            </span>
          ) : (
            <span className="h-3" />
          )}
        </button>
      ))}
    </div>
  );
}
