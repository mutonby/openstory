import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mockGenerateVideo,
  mockGetVideoJobStatus,
} from './__mocks__/fal-client.mock';

// Mock DB + env so api-key resolution falls through to platform key
vi.doMock('#db-client', () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: () => [] }) }) }),
  }),
}));

const env: Record<string, string | undefined> = {
  FAL_KEY: 'test-fal-key',
  OPENROUTER_KEY: 'test-or-key',
};

vi.doMock('#env', () => ({
  getEnv: () => env,
}));

const { submitMotionJob, pollMotionJob } = await import('./motion-generation');

describe('Motion Service', () => {
  beforeEach(() => {
    mockGenerateVideo.mockClear();
    mockGetVideoJobStatus.mockClear();
    env.ARK_API_KEY = undefined;
    env.ARK_BASE_URL = undefined;
    env.E2E_TEST = undefined;
  });

  describe('submitMotionJob', () => {
    it('should submit job with Kling v3 Pro model options', async () => {
      mockGenerateVideo.mockResolvedValue({
        jobId: 'test-kling-v3-request-id',
        model: 'fal-ai/kling-video/v3/pro/image-to-video',
      });

      const result = await submitMotionJob({
        imageUrl: 'https://example.com/image.jpg',
        prompt: 'A person walking',
        model: 'kling_v3_pro',
        duration: 5,
      });

      expect(result.jobId).toBe('test-kling-v3-request-id');
      expect(result.modelKey).toBe('kling_v3_pro');
      expect(result.via).toBe('fal');
      expect(result.usedOwnKey).toBe(false);
      expect(result.submittedAt).toBeGreaterThan(0);

      expect(mockGenerateVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'A person walking',
          modelOptions: expect.objectContaining({
            start_image_url: 'https://example.com/image.jpg',
            duration: '5',
            cfg_scale: 0.5,
            negative_prompt:
              'blur, distort, and low quality, background music, musical score, soundtrack',
          }),
        })
      );
    });

    it('should submit job with Seedance 2 model options', async () => {
      mockGenerateVideo.mockResolvedValue({
        jobId: 'test-seedance-request-id',
        model: 'bytedance/seedance-2.5/image-to-video',
      });

      const result = await submitMotionJob({
        imageUrl: 'https://example.com/image.jpg',
        prompt: 'Dynamic action sequence',
        model: 'seedance_v2',
        duration: 5,
        fps: 25,
      });

      expect(result.jobId).toBe('test-seedance-request-id');
      expect(result.modelKey).toBe('seedance_v2');

      expect(mockGenerateVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Dynamic action sequence',
          modelOptions: expect.objectContaining({
            image_url: 'https://example.com/image.jpg',
          }),
        })
      );
    });

    it('should handle submission failure', async () => {
      mockGenerateVideo.mockRejectedValue(new Error('API error'));

      await expect(
        submitMotionJob({
          imageUrl: 'https://example.com/image.jpg',
          prompt: 'Test prompt',
          model: 'kling_v3_pro',
        })
      ).rejects.toThrow('API error');
    });

    it('should submit job with Veo 3.1 model options', async () => {
      mockGenerateVideo.mockResolvedValue({
        jobId: 'test-veo3-1-request-id',
        model: 'fal-ai/veo3.1/image-to-video',
      });

      const result = await submitMotionJob({
        imageUrl: 'https://example.com/image.jpg',
        prompt: 'Smooth camera movement',
        model: 'veo3_1',
        duration: 8,
      });

      expect(result.jobId).toBe('test-veo3-1-request-id');
      expect(result.modelKey).toBe('veo3_1');

      expect(mockGenerateVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'Smooth camera movement',
          modelOptions: expect.objectContaining({
            image_url: 'https://example.com/image.jpg',
          }),
        })
      );
    });

    it('stamps via byteplus for Seedance when Ark is configured', async () => {
      env.ARK_API_KEY = 'ark-test';
      mockGenerateVideo.mockResolvedValue({ jobId: 'ark-job-id' });

      const result = await submitMotionJob({
        imageUrl: 'https://example.com/image.jpg',
        prompt: 'Dynamic action sequence',
        model: 'seedance_v2',
        duration: 5,
      });

      expect(result.via).toBe('byteplus');
      expect(result.usedOwnKey).toBe(false);
      expect(result.jobId).toBe('ark-job-id');
    });

    it('keeps Kling on fal even when Ark is configured', async () => {
      env.ARK_API_KEY = 'ark-test';
      mockGenerateVideo.mockResolvedValue({
        jobId: 'kling-job',
        model: 'fal-ai/kling-video/v3/pro/image-to-video',
      });

      const result = await submitMotionJob({
        imageUrl: 'https://example.com/image.jpg',
        prompt: 'A person walking',
        model: 'kling_v3_pro',
        duration: 5,
      });

      expect(result.via).toBe('fal');
    });
  });

  describe('pollMotionJob', () => {
    it('polls fal by default so pre-#1216 submissions keep working', async () => {
      mockGetVideoJobStatus.mockResolvedValue({
        jobId: 'job-1',
        status: 'completed',
        url: 'https://example.com/video.mp4',
        usage: { unitsBilled: 12 },
      });

      const result = await pollMotionJob('job-1', 'kling_v3_pro');

      expect(result.status).toBe('completed');
      expect(result.url).toBe('https://example.com/video.mp4');
      expect(mockGetVideoJobStatus).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'job-1' })
      );
    });

    it('throws on an unknown via stamp', async () => {
      await expect(
        pollMotionJob('job-1', 'kling_v3_pro', undefined, 'xai')
      ).rejects.toThrow('Unknown media via: xai');
    });

    it('polls the BytePlus via when the job was stamped byteplus', async () => {
      env.ARK_API_KEY = 'ark-test';
      mockGetVideoJobStatus.mockResolvedValue({
        jobId: 'ark-job-1',
        status: 'completed',
        url: 'https://example.com/video.mp4',
        usage: { totalTokens: 108_000 },
      });

      const result = await pollMotionJob(
        'ark-job-1',
        'seedance_v2',
        undefined,
        'byteplus'
      );

      expect(result.status).toBe('completed');
      expect(mockGetVideoJobStatus).toHaveBeenCalledWith(
        expect.objectContaining({ jobId: 'ark-job-1' })
      );
    });
  });
});
