'use strict';

const CARD_MOVE_MS = 650;
const CARD_SPRING = Object.freeze({ response: 0.5, damping: 0.86 });

function advanceCardFrame(motion, elapsed, cardSpring, done) {
  const seconds = elapsed / 1000, omega = 2 * Math.PI / cardSpring.response;
  const decayRate = cardSpring.damping * omega, frequency = omega * Math.sqrt(1 - cardSpring.damping ** 2);
  const decay = Math.exp(-decayRate * seconds), cosine = Math.cos(frequency * seconds), sine = Math.sin(frequency * seconds);
  motion.frame = Object.fromEntries(motion.keys.map(key => {
    // This is the velocity carried into this motion, not the sample written
    // below. Re-reading the latter turns the closed-form spring into feedback.
    const speed = motion.initialVelocity[key] || 0;
    const displacement = motion.from[key] - motion.to[key];
    const b = (speed + decayRate * displacement) / frequency;
    motion.velocity[key] = done ? 0 : decay * ((frequency * b - decayRate * displacement) * cosine
      - (frequency * displacement + decayRate * b) * sine);
    return [key, done ? motion.to[key] : Math.round(motion.to[key] + decay * (displacement * cosine + b * sine))];
  }));
  return motion.frame;
}

module.exports = { CARD_MOVE_MS, CARD_SPRING, advanceCardFrame };
