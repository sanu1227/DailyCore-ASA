# Scale only this notification's PCM samples; never change Windows master volume.
if (-not ('RinWaveVolume' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
public static class RinWaveVolume {
    public static byte[] Scale(byte[] input, int volume) {
        if (volume < 0 || volume > 100) throw new ArgumentOutOfRangeException("volume");
        byte[] data = (byte[])input.Clone();
        bool pcm16 = false;
        for (int p = 12; p + 8 <= data.Length;) {
            string name = Encoding.ASCII.GetString(data, p, 4);
            int length = BitConverter.ToInt32(data, p + 4);
            if (length < 0 || (long)p + 8 + length > data.Length) throw new ArgumentException("Invalid WAV");
            if (name == "fmt " && length >= 16) pcm16 = BitConverter.ToInt16(data, p + 8) == 1 && BitConverter.ToInt16(data, p + 22) == 16;
            if (name == "data") {
                if (!pcm16) throw new ArgumentException("Expected PCM16 WAV");
                for (int i = p + 8; i + 1 < p + 8 + length; i += 2) {
                    short sample = (short)(BitConverter.ToInt16(data, i) * volume / 100);
                    data[i] = (byte)(sample & 255); data[i+1] = (byte)((sample >> 8) & 255);
                }
            }
            p += 8 + length + (length % 2);
        }
        return data;
    }
}
'@
}
