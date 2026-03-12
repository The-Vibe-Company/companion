import { useState, useRef, useEffect, useCallback } from "react";

// Web Speech API type declarations (not in standard lib.dom.d.ts)
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionResultList {
  length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  length: number;
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: Event & { error: string }) => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

const getSpeechRecognition = (): SpeechRecognitionConstructor | null => {
  if (typeof window === "undefined") return null;
  return (
    (window as unknown as Record<string, unknown>).SpeechRecognition as SpeechRecognitionConstructor ??
    (window as unknown as Record<string, unknown>).webkitSpeechRecognition as SpeechRecognitionConstructor ??
    null
  );
};

export interface UseSpeechToTextOptions {
  onTranscript: (text: string) => void;
  lang?: string;
}

export interface UseSpeechToTextReturn {
  isListening: boolean;
  isSupported: boolean;
  interimText: string;
  startListening: () => void;
  stopListening: () => void;
  toggleListening: () => void;
}

export function useSpeechToText({ onTranscript, lang }: UseSpeechToTextOptions): UseSpeechToTextReturn {
  const SpeechRecognition = getSpeechRecognition();
  const isSupported = SpeechRecognition !== null;

  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState("");

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const listeningRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  useEffect(() => {
    if (!SpeechRecognition) return;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    if (lang) recognition.lang = lang;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          onTranscriptRef.current(result[0].transcript);
        } else {
          interim += result[0].transcript;
        }
      }
      setInterimText(interim);
    };

    recognition.onend = () => {
      if (listeningRef.current) {
        // Browser auto-stopped (e.g., after silence); restart
        try {
          recognition.start();
        } catch {
          // Already started or other error — stop gracefully
          listeningRef.current = false;
          setIsListening(false);
          setInterimText("");
        }
      } else {
        setInterimText("");
      }
    };

    recognition.onerror = (event: Event & { error: string }) => {
      // "aborted" is expected when we call stop() while listening
      if (event.error === "aborted") return;
      console.warn("[speech-to-text] error:", event.error);
      listeningRef.current = false;
      setIsListening(false);
      setInterimText("");
    };

    recognitionRef.current = recognition;

    return () => {
      listeningRef.current = false;
      try {
        recognition.abort();
      } catch {
        // Ignore
      }
      recognitionRef.current = null;
    };
  }, [SpeechRecognition, lang]);

  const startListening = useCallback(() => {
    if (!recognitionRef.current || listeningRef.current) return;
    listeningRef.current = true;
    setIsListening(true);
    setInterimText("");
    try {
      recognitionRef.current.start();
    } catch {
      listeningRef.current = false;
      setIsListening(false);
    }
  }, []);

  const stopListening = useCallback(() => {
    if (!recognitionRef.current || !listeningRef.current) return;
    listeningRef.current = false;
    setIsListening(false);
    setInterimText("");
    try {
      recognitionRef.current.stop();
    } catch {
      // Ignore
    }
  }, []);

  const toggleListening = useCallback(() => {
    if (listeningRef.current) {
      stopListening();
    } else {
      startListening();
    }
  }, [startListening, stopListening]);

  return {
    isListening,
    isSupported,
    interimText,
    startListening,
    stopListening,
    toggleListening,
  };
}
