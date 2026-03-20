const express = require('express');
const router = express.Router();
const supabase = require('../supabase');
const { authenticateToken } = require('../middleware/auth');

// Get all questions (with filters)
router.get('/', async (req, res) => {
  try {
    const { category, search, solved, limit = 20, offset = 0 } = req.query;
    
    let query = supabase
      .from('questions')
      .select(`
        *,
        author:users!author_id(id, name, profile_image_url),
        answers:answers(count)
      `)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    // Apply filters
    if (category && category !== 'All') {
      query = query.eq('category', category.toLowerCase());
    }
    
    if (search) {
      query = query.ilike('title', `%${search}%`);
    }
    
    if (solved !== undefined) {
      query = query.eq('solved', solved === 'true');
    }

    const { data: questions, error } = await query;

    if (error) throw error;

    // Format response
    const formattedQuestions = questions.map(q => ({
      id: q.id,
      title: q.title,
      description: q.description,
      category: q.category,
      author: q.author?.name || 'Anonymous',
      authorId: q.author_id,
      authorImage: q.author?.profile_image_url || '',
      answers: q.answers?.[0]?.count || 0,
      likes: q.likes || 0,
      solved: q.solved || false,
      createdAt: q.created_at,
    }));

    res.status(200).json({
      success: true,
      questions: formattedQuestions,
      count: formattedQuestions.length
    });

  } catch (error) {
    console.error('Get questions error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch questions' 
    });
  }
});

// Get single question with answers
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Get question
    const { data: question, error: qError } = await supabase
      .from('questions')
      .select(`
        *,
        author:users!author_id(id, name, profile_image_url)
      `)
      .eq('id', id)
      .single();

    if (qError || !question) {
      return res.status(404).json({
        success: false,
        error: 'Question not found'
      });
    }

    // Get answers
    const { data: answers, error: aError } = await supabase
      .from('answers')
      .select(`
        *,
        author:users!author_id(id, name, profile_image_url)
      `)
      .eq('question_id', id)
      .order('created_at', { ascending: true });

    if (aError) throw aError;

    const formattedAnswers = answers.map(a => ({
      id: a.id,
      text: a.text,
      author: a.author?.name || 'Anonymous',
      authorId: a.author_id,
      authorImage: a.author?.profile_image_url || '',
      likes: a.likes || 0,
      isAccepted: a.is_accepted || false,
      createdAt: a.created_at,
    }));

    res.status(200).json({
      success: true,
      question: {
        id: question.id,
        title: question.title,
        description: question.description,
        category: question.category,
        author: question.author?.name || 'Anonymous',
        authorId: question.author_id,
        authorImage: question.author?.profile_image_url || '',
        likes: question.likes || 0,
        solved: question.solved || false,
        createdAt: question.created_at,
        answers: formattedAnswers
      }
    });

  } catch (error) {
    console.error('Get question error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to fetch question' 
    });
  }
});

// Create new question
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { title, description, category } = req.body;
    const userId = req.user.id;

    if (!title || !category) {
      return res.status(400).json({
        success: false,
        error: 'Title and category are required'
      });
    }

    const { data: question, error } = await supabase
      .from('questions')
      .insert({
        title,
        description: description || null,
        category: category.toLowerCase(),
        author_id: userId,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    // Get author info
    const { data: author } = await supabase
      .from('users')
      .select('name, profile_image_url')
      .eq('id', userId)
      .single();

    // Broadcast via WebSocket if available
    const wsServer = req.app.get('wsServer');
    if (wsServer) {
      wsServer.sendNotification(null, {
        type: 'new_question',
        question: {
          id: question.id,
          title: question.title,
          description: question.description,
          category: question.category,
          author: author?.name || 'Anonymous',
          authorId: userId,
          authorImage: author?.profile_image_url || '',
          answers: 0,
          likes: 0,
          solved: false,
          createdAt: question.created_at
        }
      });
    }

    res.status(201).json({
      success: true,
      message: 'Question posted successfully',
      question: {
        id: question.id,
        title: question.title,
        description: question.description,
        category: question.category,
        author: author?.name || 'Anonymous',
        authorId: userId,
        authorImage: author?.profile_image_url || '',
        answers: 0,
        likes: 0,
        solved: false,
        createdAt: question.created_at
      }
    });

  } catch (error) {
    console.error('Create question error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to post question' 
    });
  }
});

// Update question (like, solved status)
router.put('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { likes, solved } = req.body;
    const userId = req.user.id;

    const updateData = {};
    if (likes !== undefined) updateData.likes = likes;
    if (solved !== undefined) updateData.solved = solved;
    updateData.updated_at = new Date().toISOString();

    const { data: question, error } = await supabase
      .from('questions')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: 'Question updated successfully',
      question
    });

  } catch (error) {
    console.error('Update question error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to update question' 
    });
  }
});

// Add answer to question
router.post('/:id/answers', authenticateToken, async (req, res) => {
  try {
    const { id: questionId } = req.params;
    const { text } = req.body;
    const userId = req.user.id;

    if (!text) {
      return res.status(400).json({
        success: false,
        error: 'Answer text is required'
      });
    }

    // Check if question exists
    const { data: question, error: qError } = await supabase
      .from('questions')
      .select('id')
      .eq('id', questionId)
      .single();

    if (qError || !question) {
      return res.status(404).json({
        success: false,
        error: 'Question not found'
      });
    }

    // Add answer
    const { data: answer, error } = await supabase
      .from('answers')
      .insert({
        question_id: questionId,
        author_id: userId,
        text,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    // Get author info
    const { data: author } = await supabase
      .from('users')
      .select('name, profile_image_url')
      .eq('id', userId)
      .single();

    // Broadcast via WebSocket
    const wsServer = req.app.get('wsServer');
    if (wsServer) {
      wsServer.sendNotification(null, {
        type: 'new_answer',
        questionId,
        answer: {
          id: answer.id,
          text: answer.text,
          author: author?.name || 'Anonymous',
          authorId: userId,
          authorImage: author?.profile_image_url || '',
          likes: 0,
          isAccepted: false,
          createdAt: answer.created_at
        }
      });
    }

    res.status(201).json({
      success: true,
      message: 'Answer added successfully',
      answer: {
        id: answer.id,
        text: answer.text,
        author: author?.name || 'Anonymous',
        authorId: userId,
        authorImage: author?.profile_image_url || '',
        likes: 0,
        isAccepted: false,
        createdAt: answer.created_at
      }
    });

  } catch (error) {
    console.error('Add answer error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to add answer' 
    });
  }
});

// Like/Unlike answer
router.put('/answers/:answerId/like', authenticateToken, async (req, res) => {
  try {
    const { answerId } = req.params;
    const { like } = req.body; // true = like, false = unlike

    const { data: answer, error } = await supabase
      .from('answers')
      .select('likes')
      .eq('id', answerId)
      .single();

    if (error || !answer) {
      return res.status(404).json({
        success: false,
        error: 'Answer not found'
      });
    }

    const newLikes = like ? (answer.likes + 1) : Math.max(0, answer.likes - 1);

    const { data: updatedAnswer, error: updateError } = await supabase
      .from('answers')
      .update({ 
        likes: newLikes,
        updated_at: new Date().toISOString()
      })
      .eq('id', answerId)
      .select()
      .single();

    if (updateError) throw updateError;

    res.status(200).json({
      success: true,
      message: like ? 'Answer liked' : 'Answer unliked',
      likes: updatedAnswer.likes
    });

  } catch (error) {
    console.error('Like answer error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to like answer' 
    });
  }
});

// Accept answer as solution
router.put('/answers/:answerId/accept', authenticateToken, async (req, res) => {
  try {
    const { answerId } = req.params;
    const userId = req.user.id;

    // Get answer details
    const { data: answer, error: aError } = await supabase
      .from('answers')
      .select('question_id, author_id')
      .eq('id', answerId)
      .single();

    if (aError || !answer) {
      return res.status(404).json({
        success: false,
        error: 'Answer not found'
      });
    }

    // Get question to verify ownership
    const { data: question, error: qError } = await supabase
      .from('questions')
      .select('author_id')
      .eq('id', answer.question_id)
      .single();

    if (qError || !question) {
      return res.status(404).json({
        success: false,
        error: 'Question not found'
      });
    }

    // Only question author can accept answer
    if (question.author_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Only the question author can accept answers'
      });
    }

    // Mark answer as accepted and question as solved
    const { error: updateError } = await supabase
      .from('answers')
      .update({ 
        is_accepted: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', answerId);

    if (updateError) throw updateError;

    await supabase
      .from('questions')
      .update({ 
        solved: true,
        updated_at: new Date().toISOString()
      })
      .eq('id', answer.question_id);

    res.status(200).json({
      success: true,
      message: 'Answer accepted as solution'
    });

  } catch (error) {
    console.error('Accept answer error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to accept answer' 
    });
  }
});

// Delete answer
router.delete('/answers/:answerId', authenticateToken, async (req, res) => {
  try {
    const { answerId } = req.params;
    const userId = req.user.id;

    // Check if user is answer author
    const { data: answer, error: checkError } = await supabase
      .from('answers')
      .select('author_id')
      .eq('id', answerId)
      .single();

    if (checkError || !answer) {
      return res.status(404).json({
        success: false,
        error: 'Answer not found'
      });
    }

    if (answer.author_id !== userId) {
      return res.status(403).json({
        success: false,
        error: 'You can only delete your own answers'
      });
    }

    const { error } = await supabase
      .from('answers')
      .delete()
      .eq('id', answerId);

    if (error) throw error;

    res.status(200).json({
      success: true,
      message: 'Answer deleted successfully'
    });

  } catch (error) {
    console.error('Delete answer error:', error);
    res.status(500).json({ 
      success: false,
      error: 'Failed to delete answer' 
    });
  }
});

module.exports = router;
