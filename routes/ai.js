const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');

// OpenAI API endpoint (using your backend as proxy)
router.post('/chat', authenticateToken, async (req, res) => {
  try {
    const { messages, trainingContext } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid messages format'
      });
    }

    // Get API key from environment variable (SECURE!)
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    
    if (!OPENAI_API_KEY) {
      console.error('❌ OPENAI_API_KEY not set in environment variables');
      return res.status(500).json({
        success: false,
        error: 'AI service not configured. Please add OPENAI_API_KEY to environment variables.'
      });
    }

    // Prepare the system prompt with training context
    let systemPrompt = `You are a helpful gardening assistant for a community food sharing app called "Harvest Hub". 
You help users with:
- Gardening questions (planting, harvesting, pests, diseases)
- Crop growing advice
- Organic farming tips
- Soil preparation and maintenance
- Seasonal planting guides

Be friendly, knowledgeable, and practical. Keep responses concise but helpful.
If you don't know something, be honest about it.`;

    // Add training context if provided
    if (trainingContext && trainingContext.length > 0) {
      systemPrompt += `\n\nHere are some relevant examples from our community:\n${trainingContext}`;
    }

    console.log('🤖 Sending request to OpenAI API...');
    console.log('📝 System prompt length:', systemPrompt.length);
    
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
        ],
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error('❌ OpenAI API error:', data);
      return res.status(response.status).json({
        success: false,
        error: data.error?.message || 'AI service error'
      });
    }

    const assistantMessage = data.choices[0]?.message?.content || 'No response generated';
    
    console.log('✅ AI response generated successfully');
    
    res.status(200).json({
      success: true,
      message: assistantMessage,
      usage: data.usage // Optional: track token usage
    });

  } catch (error) {
    console.error('❌ AI route error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get AI response: ' + error.message
    });
  }
});

// Endpoint to get AI suggestion for post
router.post('/suggest-post', authenticateToken, async (req, res) => {
  try {
    const { topic, existingPosts } = req.body;
    
    if (!topic || topic.trim().isEmpty) {
      return res.status(400).json({
        success: false,
        error: 'Topic is required'
      });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    
    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'AI service not configured'
      });
    }

    const systemPrompt = `You are a helpful assistant for a gardening community. Help users write engaging posts about their gardening experiences, questions, or tips. 
Suggest a well-structured post that includes:
- A catchy title
- The main body content
- Any specific questions they might want to ask

Format your response as:
TITLE: [suggested title]
BODY: [suggested body content]

Keep it conversational and friendly. Make it sound like a real community member.`;

    const userPrompt = `I want to write a post about: ${topic}. Please suggest a title and content for my post.`;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.8,
        max_tokens: 300,
      }),
    });

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error?.message || 'Failed to get suggestion');
    }

    const suggestion = data.choices[0]?.message?.content || '';
    
    // Parse title and body
    let title = '';
    let body = '';
    
    const titleMatch = suggestion.match(/TITLE:\s*(.+?)(?:\n|$)/i);
    const bodyMatch = suggestion.match(/BODY:\s*([\s\S]+?)(?:\n\n|$)/i);
    
    if (titleMatch) title = titleMatch[1].trim();
    if (bodyMatch) body = bodyMatch[1].trim();
    
    // Fallback if parsing fails
    if (!title && !body) {
      const lines = suggestion.split('\n');
      title = lines[0].replace(/^TITLE:\s*/i, '').trim();
      body = lines.slice(1).join('\n').replace(/^BODY:\s*/i, '').trim();
    }

    res.status(200).json({
      success: true,
      title: title || topic,
      body: body || suggestion,
      fullSuggestion: suggestion
    });

  } catch (error) {
    console.error('❌ Post suggestion error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate suggestion: ' + error.message
    });
  }
});

// Endpoint to get answer for a question (for AI Assistant)
router.post('/ask', authenticateToken, async (req, res) => {
  try {
    const { question, context } = req.body;
    
    if (!question || question.trim().isEmpty) {
      return res.status(400).json({
        success: false,
        error: 'Question is required'
      });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    
    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'AI service not configured'
      });
    }

    let systemPrompt = `You are a knowledgeable gardening assistant for the Harvest Hub community. 
You help with:
- Gardening advice (planting, watering, fertilizing, pests, diseases)
- Crop-specific guidance (vegetables, fruits, herbs)
- Organic and sustainable gardening practices
- Seasonal growing tips
- Troubleshooting plant problems

Be friendly, helpful, and practical. If asked about something outside gardening, politely redirect to gardening topics.
Keep responses concise (2-3 paragraphs maximum). Use examples when helpful.`;

    if (context && context.length > 0) {
      systemPrompt += `\n\nHere is some relevant community knowledge you can reference:\n${context}`;
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question }
        ],
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error?.message || 'Failed to get answer');
    }

    const answer = data.choices[0]?.message?.content || 'I apologize, I could not generate a response.';

    res.status(200).json({
      success: true,
      answer: answer,
      usage: data.usage
    });

  } catch (error) {
    console.error('❌ Ask question error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get answer: ' + error.message
    });
  }
});


// OpenAI version (replace the Claude code above)
router.post('/analyze-image', authenticateToken, async (req, res) => {
  try {
    const { imageBase64, contentType } = req.body;
    
    if (!imageBase64) {
      return res.status(400).json({
        success: false,
        error: 'No image data provided'
      });
    }

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    
    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'AI service not configured'
      });
    }

    // OpenAI Vision API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `You are an expert at identifying garden produce, fruits, vegetables, herbs, and crops from images.
Analyze this image and respond ONLY with valid JSON in this exact format (no explanation, no markdown):
{
  "name": "short produce name (e.g. Heirloom Roma Tomatoes)",
  "description": "2-3 sentence natural, warm description of the produce",
  "category": "one of: Vegetables, Fruits, Herbs, Seeds, Other"
}
If you cannot identify produce in the image, respond with:
{"name": "", "description": "", "category": "Other"}`,
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${contentType || 'image/jpeg'};base64,${imageBase64}`,
                },
              },
            ],
          },
        ],
        max_tokens: 500,
      }),
    });

    const data = await response.json();
    
    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: data.error?.message || 'AI analysis failed'
      });
    }

    const rawText = data.choices[0]?.message?.content || '';
    const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    
    let result;
    try {
      result = JSON.parse(cleaned);
    } catch (e) {
      result = { name: '', description: '', category: 'Other' };
    }

    res.status(200).json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('AI image analysis error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to analyze image: ' + error.message
    });
  }
});

module.exports = router;
